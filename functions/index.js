const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

// Define secrets set by user via firebase functions:secrets:set
const jsonbinKey = defineSecret("JSONBIN_KEY");
const employeeBin = defineSecret("EMPLOYEE_BIN");
const distributionBin = defineSecret("DISTRIBUTION_BIN");
const visitsBin = defineSecret("VISITS_BIN");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

exports.onNewPost = onDocumentCreated({
    document: "posts/{postId}",
    secrets: [jsonbinKey, employeeBin, distributionBin, visitsBin]
}, async (event) => {
    const post = event.data.data();
    const postId = event.params.postId;
    const postGroup = post.tags && post.tags[0];
    const postDate = post.targetDate;

    console.log(`New post detected: ${postId} (Group: ${postGroup || 'All'}, Date: ${postDate || 'None'}) by ${post.authorName}`);

    try {
        // 1. Fetch JSONBin Data concurrently
        const headers = { "X-Master-Key": jsonbinKey.value() };
        const [empRes, distRes, visitRes] = await Promise.all([
            fetch(`https://api.jsonbin.io/v3/b/${employeeBin.value()}/latest`, { headers }),
            fetch(`https://api.jsonbin.io/v3/b/${distributionBin.value()}/latest`, { headers }),
            fetch(`https://api.jsonbin.io/v3/b/${visitsBin.value()}/latest`, { headers })
        ]);

        // Check for HTTP errors before parsing
        if (!empRes.ok) {
            console.error(`ERROR: Employee bin fetch failed with status ${empRes.status}. Bin ID: ${employeeBin.value()}`);
        }
        if (!distRes.ok) {
            console.error(`ERROR: Distribution bin fetch failed with status ${distRes.status}.`);
        }
        if (!visitRes.ok) {
            console.error(`ERROR: Visits bin fetch failed with status ${visitRes.status}.`);
        }

        const empData = await empRes.json();
        const distData = await distRes.json();
        const visitData = await visitRes.json();

        console.log(`DEBUG: empData keys: ${Object.keys(empData || {}).join(', ')}`);

        // Structure similar to groupsState in index.html
        // Robust fallback: handles array, object with .employees, or missing record
        let employees = [];
        if (empData && empData.record) {
            employees = Array.isArray(empData.record)
                ? empData.record
                : (empData.record.employees || empData.record.mitarbeiter || []);
        } else {
            console.error("WARNING: Could not load employee data from JSONBin. Sending to all tokens (unfiltered).");
        }
        console.log(`LOG: ${employees.length} employees loaded.`);

        const groupsState = {
            hausdienst: (distData && distData.record) ? distData.record : {},
            visits: (visitData && visitData.record) ? visitData.record : {}
        };

        // 2. Get all registered FCM tokens
        const tokensSnapshot = await db.collection("fcm_tokens").get();
        if (tokensSnapshot.empty) {
            console.log("No FCM tokens registered.");
            return null;
        }

        const employeesLoaded = employees.length > 0;
        const relevantTokens = [];

        // 3. Filtering logic (Server-side replication of isUserInDienstGroup)
        tokensSnapshot.forEach(doc => {
            const data = doc.data();
            const token = data.token;
            const mitarbeiterId = doc.id;

            // If employee data couldn't be loaded, send to everyone (fallback)
            if (!employeesLoaded) {
                relevantTokens.push(token);
                return;
            }

            // Special case: 'admin' UID is always an administrator
            if (mitarbeiterId === 'admin') {
                console.log(`DEBUG: Admin token found, always sending.`);
                relevantTokens.push(token);
                return;
            }

            // Find employee in JSONBin list to get their role and name
            // Try exact match first, then numeric fallback (e.g. 'emp_00004' → '4')
            let employee = employees.find(e => String(e.id || e.mitarbeiter_id) === String(mitarbeiterId));
            if (!employee) {
                // Try extracting numeric part from IDs like 'emp_00004' → 4
                const numericId = parseInt(mitarbeiterId.replace(/\D/g, ''), 10);
                if (!isNaN(numericId)) {
                    employee = employees.find(e => parseInt(e.id || e.mitarbeiter_id, 10) === numericId);
                }
            }
            if (!employee) {
                console.log(`DEBUG: Employee not found in JSONBin for token of UID ${mitarbeiterId}`);
                return;
            }

            const name = (employee.name || employee.mitarbeiter_name || "").toLowerCase();
            const role = (employee.role || "");
            const isAdmin = role === 'Administrator' || name === 'administrator';

            // Admins always get notifications
            if (isAdmin) {
                relevantTokens.push(token);
                return;
            }

            // If no group is tagged, it's relevant to everyone
            if (!postGroup) {
                relevantTokens.push(token);
                return;
            }

            // Check if user is in group
            let isRelevant = false;
            for (const type of ['hausdienst', 'visits']) {
                const state = groupsState[type];
                // Handle different JSON structures (assignments, distributions, or flat record)
                let distributions = state.assignments || state.distributions || (state.record ? (state.record.assignments || state.record) : state) || {};

                if (postDate) {
                    const dateObj = new Date(postDate);
                    const monatId = `month_${dateObj.getFullYear()}_${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
                    const month = (state.months || []).find(m => m.monat_id === monatId);
                    if (month && (month.distributions || month.assignments)) {
                        distributions = month.distributions || month.assignments;
                    }
                }

                const reverseLabels = { 'Station 46': 'visite_46', 'Station 18': 'visite_18', 'Station 19': 'visite_19' };
                let searchKey = postGroup;
                if (reverseLabels[postGroup]) searchKey = reverseLabels[postGroup];

                const nameCheck = (n) => {
                    if (!n) return false;
                    // Robust Matching (ID fallback)
                    if (typeof n === 'object') {
                        const nId = n.employeeId || n.id || n.mitarbeiter_id;
                        if (nId && String(nId) === String(mitarbeiterId)) return true;
                    }
                    const normalize = (str) => String(str).toLowerCase().replace(/\(.*\)/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
                    const cleanDistName = normalize(typeof n === 'object' ? (n.name || n.mitarbeiter_name || "") : n);
                    const cleanUserName = normalize(name);
                    if (!cleanDistName || !cleanUserName) return false;
                    if (cleanDistName === cleanUserName) return true;
                    const ignoreList = ['dr', 'dr.', 'med', 'med.', 'prof', 'prof.'];
                    const distWords = cleanDistName.split(' ').filter(w => w.length > 2 && !ignoreList.includes(w));
                    const userWords = cleanUserName.split(' ').filter(w => w.length > 2 && !ignoreList.includes(w));
                    if (distWords.length === 0 || userWords.length === 0) return false;
                    return distWords.every(dw => userWords.includes(dw)) || userWords.every(uw => distWords.includes(uw));
                };

                const assigned = distributions[searchKey];
                if (assigned) {
                    const names = Array.isArray(assigned) ? assigned : [assigned];
                    if (names.some(nameCheck)) {
                        console.log(`DEBUG: Match found for ${name} in ${searchKey}`);
                        isRelevant = true;
                        break;
                    }
                }
                const pool = distributions['pool'];
                if (pool) {
                    const poolNames = Array.isArray(pool) ? pool : [pool];
                    if (poolNames.some(nameCheck)) {
                        const catGroups = {
                            hausdienst: ['1. Hausdienst', '2. Hausdienst', '3. Hausdienst', 'Echo-Hintergrund', 'Broncho-Hintergrund', 'Kardio-Hintergrund'],
                            visits: ['Station 46', 'Station 18', 'Station 19']
                        };
                        if ((catGroups[type] || []).includes(postGroup)) {
                            console.log(`DEBUG: Match found for ${name} via pool in ${postGroup}`);
                            isRelevant = true;
                            break;
                        }
                    }
                }
            }

            if (isRelevant) {
                relevantTokens.push(token);
            }
        });

        const tokensToSend = [...new Set(relevantTokens)];
        if (tokensToSend.length === 0) {
            console.log("No relevant recipients found.");
            return null;
        }

        console.log(`Sending notification to ${tokensToSend.length} devices (filtered from ${tokensSnapshot.size}).`);

        // 4. Send Messaging
        const msgBody = post.body || "";
        const preview = msgBody.length > 100 ? msgBody.substring(0, 100) + "..." : msgBody;
        const notificationBody = post.title ? `${post.title}${preview ? `: ${preview}` : ''}` : (preview || "Neuer Beitrag im Dienste-Chat");

        const message = {
            notification: {
                title: `${post.authorName}${postGroup ? ` (${postGroup})` : ''}`,
                body: notificationBody,
                image: 'https://lateina.github.io/Hausdienstplaner/icon_tight_192.png'
            },
            data: {
                postId: postId,
                type: "new_post"
            },
            webpush: {
                headers: {
                    Urgency: "high",
                    TTL: "0" // Immediate delivery
                },
                notification: {
                    title: `${post.authorName}${postGroup ? ` (${postGroup})` : ''}`,
                    body: notificationBody,
                    icon: 'https://lateina.github.io/Hausdienstplaner/icon_tight_192.png',
                    badge: 'https://lateina.github.io/Hausdienstplaner/icon_tight_192.png'
                },
                fcm_options: {
                    link: `https://lateina.github.io/Hausdienstplaner/index.html?post=${postId}`
                }
            },
            tokens: tokensToSend,
        };

        const response = await messaging.sendEachForMulticast(message);
        console.log(`Multicast results: ${response.successCount} success, ${response.failureCount} failure.`);

        // Cleanup dead tokens
        if (response.failureCount > 0) {
            const cleanup = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const failedToken = tokensToSend[idx];
                    const docToDelete = tokensSnapshot.docs.find(d => d.data().token === failedToken);
                    if (docToDelete) {
                        console.log(`Cleanup: Deleting invalid token for UID ${docToDelete.id}`);
                        cleanup.push(docToDelete.ref.delete());
                    }
                }
            });
            await Promise.all(cleanup);
        }

    } catch (error) {
        console.error("CRITICAL ERROR in Cloud Function onNewPost:", error);
    }
    return null;
});
