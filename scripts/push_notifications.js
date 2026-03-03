const { GoogleAuth } = require('google-auth-library');

// ─── Config ──────────────────────────────────────────────────────────────────
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'dienste-chat-5a359';
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT; // JSON string
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const EMP_BIN_ID = process.env.EMP_BIN_ID;
const DIST_BIN_ID = process.env.DIST_BIN_ID;
const VISITS_BIN_ID = process.env.VISITS_BIN_ID;

// How far back to look for new posts (in minutes)
const LOOKBACK_MINUTES = 1440; // 24 hours

console.log(`Using Firebase Project ID: ${FIREBASE_PROJECT_ID}`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getFcmAccessToken() {
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    const auth = new GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    return tokenResponse.token;
}

async function firestoreGet(collection) {
    // Public read (no auth required with permissive rules)
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}?pageSize=500`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(`Firestore fetch ${collection} failed: ${JSON.stringify(data)}`);
    return (data.documents || []).map(doc => {
        const fields = doc.fields || {};
        const obj = { _id: doc.name.split('/').pop(), _ref: doc.name };
        for (const [key, val] of Object.entries(fields)) {
            if (val.stringValue !== undefined) obj[key] = val.stringValue;
            else if (val.booleanValue !== undefined) obj[key] = val.booleanValue;
            else if (val.timestampValue !== undefined) obj[key] = val.timestampValue;
            else if (val.arrayValue !== undefined) obj[key] = (val.arrayValue.values || []).map(v => v.stringValue || v);
            else if (val.integerValue !== undefined) obj[key] = parseInt(val.integerValue, 10);
        }
        return obj;
    });
}

async function firestorePatch(docRef, fields) {
    // Mark a document field (no auth required with permissive rules)
    const body = { fields: {} };
    for (const [key, val] of Object.entries(fields)) {
        if (typeof val === 'string') body.fields[key] = { stringValue: val };
        else if (typeof val === 'boolean') body.fields[key] = { booleanValue: val };
    }
    const fieldPaths = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
    const url = `https://firestore.googleapis.com/v1/${docRef}?${fieldPaths}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const err = await res.json();
        console.warn(`[WARN] Firestore PATCH failed:`, err);
    }
}

async function sendFcmPush(accessToken, fcmToken, title, body, postId) {
    const url = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;
    const message = {
        message: {
            token: fcmToken,
            notification: {
                title: title,
                body: body
            },
            data: {
                postId: String(postId),
                type: 'new_post',
                title: title,
                body: body,
                tag: String(postId),
                icon: 'https://lateina.github.io/Hausdienstplaner/icon_tight_192.png'
            },
            webpush: {
                headers: {
                    Urgency: 'high',
                    TTL: '86400'
                }
            }
        }
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
    });
    if (!res.ok) {
        const err = await res.json();
        return { success: false, error: err };
    }
    return { success: true };
}

// ─── Filtering (same logic as Cloud Function) ─────────────────────────────────

function normalize(str) {
    return String(str).toLowerCase().replace(/\(.*\)/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

function nameMatch(n, employee) {
    if (!n || !employee) return false;

    // ID Match (Priority)
    if (typeof n === 'object') {
        const nId = n.employeeId || n.id || n.mitarbeiter_id;
        const eId = employee.id || employee.mitarbeiter_id || employee.id; // Added fallback
        if (nId && eId && String(nId) === String(eId)) return true;
    }

    const cleanDistName = normalize(typeof n === 'object' ? (n.name || n.mitarbeiter_name || '') : n);
    const cleanUserName = normalize(employee.name || employee.mitarbeiter_name || '');
    if (!cleanDistName || !cleanUserName) return false;
    if (cleanDistName === cleanUserName) return true;
    const ignoreList = ['dr', 'dr.', 'med', 'med.', 'prof', 'prof.'];
    const distWords = cleanDistName.split(' ').filter(w => w.length > 2 && !ignoreList.includes(w));
    const userWords = cleanUserName.split(' ').filter(w => w.length > 2 && !ignoreList.includes(w));
    if (distWords.length === 0 || userWords.length === 0) return false;
    return distWords.every(dw => userWords.includes(dw)) || userWords.every(uw => distWords.includes(uw));
}

function isRelevant(employee, postGroup, postDate, groupsState) {
    const name = (employee.name || employee.mitarbeiter_name || '').toLowerCase();
    const role = employee.role || '';
    const id = employee.id || employee.mitarbeiter_id || '';
    if (role === 'Administrator' || name === 'administrator' || id === 'admin') return true;
    if (!postGroup) return true;

    console.log(`    Checking relevance for ${name} (Group: ${postGroup}, PostDate: ${postDate})`);

    for (const type of ['hausdienst', 'visits']) {
        const state = groupsState[type];
        if (!state) continue;

        let distributions = {};
        let foundMonth = null;

        if (postDate) {
            const dateObj = new Date(postDate);
            const monatId = `month_${dateObj.getFullYear()}_${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
            foundMonth = (state.months || []).find(m => m.monat_id === monatId);
        }

        // Fallback: If no postDate or month not found, use the latest month in the array
        if (!foundMonth && Array.isArray(state.months) && state.months.length > 0) {
            foundMonth = state.months[state.months.length - 1];
            console.log(`      No specific month found for date ${postDate}, using latest month: ${foundMonth.monat_id}`);
        }

        if (foundMonth) {
            distributions = foundMonth.distributions || foundMonth.assignments || {};
        } else {
            distributions = state.assignments || state.distributions || state || {};
        }

        console.log(`    Category ${type}: ${Object.keys(distributions).length} groups found.`);

        const reverseLabels = { 'Station 46': 'visite_46', 'Station 18': 'visite_18', 'Station 19': 'visite_19' };
        const searchKey = reverseLabels[postGroup] || postGroup;
        const assigned = distributions[searchKey];
        if (assigned) {
            const names = Array.isArray(assigned) ? assigned : [assigned];
            if (names.some(n => {
                const match = nameMatch(n, employee);
                if (match) console.log(`      ✅ Match found in group ${searchKey}: "${n.name || n}" matches "${employee.name || employee.mitarbeiter_name}"`);
                return match;
            })) return true;
        }
        const pool = distributions['pool'];
        if (pool) {
            const poolNames = Array.isArray(pool) ? pool : [pool];
            if (poolNames.some(n => nameMatch(n, employee))) {
                const catGroups = {
                    hausdienst: ['1. Hausdienst', '2. Hausdienst', '3. Hausdienst', 'Echo-Hintergrund', 'Broncho-Hintergrund', 'Kardio-Hintergrund'],
                    visits: ['Station 46', 'Station 18', 'Station 19']
                };
                if ((catGroups[type] || []).includes(postGroup)) return true;
            }
        }
    }
    return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== Push Notification Check ===');

    if (!FIREBASE_SERVICE_ACCOUNT) {
        console.error('CRITICAL: FIREBASE_SERVICE_ACCOUNT not set.');
        process.exit(1);
    }

    const cutoff = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000).toISOString();
    console.log(`Looking for posts created after: ${cutoff}`);

    // 1. Fetch data in parallel
    const [posts, fcmTokenDocs, empData, distData, visitData] = await Promise.all([
        firestoreGet('posts'),
        firestoreGet('fcm_tokens'),
        JSONBIN_KEY && EMP_BIN_ID ? fetch(`https://api.jsonbin.io/v3/b/${EMP_BIN_ID}/latest`, { headers: { 'X-Master-Key': JSONBIN_KEY } }).then(r => r.json()) : Promise.resolve(null),
        JSONBIN_KEY && DIST_BIN_ID ? fetch(`https://api.jsonbin.io/v3/b/${DIST_BIN_ID}/latest`, { headers: { 'X-Master-Key': JSONBIN_KEY } }).then(r => r.json()) : Promise.resolve(null),
        JSONBIN_KEY && VISITS_BIN_ID ? fetch(`https://api.jsonbin.io/v3/b/${VISITS_BIN_ID}/latest`, { headers: { 'X-Master-Key': JSONBIN_KEY } }).then(r => r.json()) : Promise.resolve(null),
    ]);

    const employees = empData?.record ? (Array.isArray(empData.record) ? empData.record : (empData.record.employees || empData.record.mitarbeiter || [])) : [];
    const groupsState = {
        hausdienst: distData?.record || {},
        visits: visitData?.record || {}
    };

    // Normalize Months (same as index.html)
    ['hausdienst', 'visits'].forEach(type => {
        if (Array.isArray(groupsState[type].months)) {
            groupsState[type].months.forEach((m, idx) => {
                if (!m.monat_id) m.monat_id = m.name || `month_${idx}`;
            });
        }
    });

    const employeesLoaded = employees.length > 0;
    console.log(`Loaded: ${employees.length} employees, ${fcmTokenDocs.length} FCM tokens`);

    // Debug: List all tokens
    fcmTokenDocs.forEach(d => {
        console.log(`  - Token ID: ${d._id}, Name: ${d.mitarbeiterName || 'unknown'}`);
    });

    // 2. Get FCM access token
    let accessToken;
    try {
        accessToken = await getFcmAccessToken();
    } catch (e) {
        console.error('CRITICAL: Could not get FCM access token:', e.message);
        process.exit(1);
    }

    // 3. Find new posts and new replies that haven't been notified yet
    const itemsToNotify = [];
    posts.forEach(p => {
        if (p.isDone) return; // Skip finished posts
        if (!p.createdAt) return;

        // Check the main post
        if (!p.notifiedAt && p.createdAt > cutoff) {
            itemsToNotify.push({
                type: 'post',
                post: p,
                id: p._id,
                authorId: String(p.mitarbeiterId || p.authorId || ''),
                authorName: p.authorName || '',
                group: p.tags && p.tags[0] ? p.tags[0] : null,
                date: p.targetDate || null,
                title: p.title || '',
                body: p.body || ''
            });
        }

        // Check replies
        if (p.replies && Array.isArray(p.replies)) {
            p.replies.forEach((r, idx) => {
                if (!r.notifiedAt && r.createdAt && r.createdAt > cutoff) {
                    itemsToNotify.push({
                        type: 'reply',
                        post: p,
                        replyIndex: idx,
                        id: r.id || `${p._id}-reply-${idx}`,
                        authorId: '', // Replies currently don't store authorId, only authorName. Post author/admin will be notified.
                        authorName: r.authorName || '',
                        group: p.tags && p.tags[0] ? p.tags[0] : null,
                        date: p.targetDate || null,
                        title: p.title || '',
                        body: r.body || ''
                    });
                }
            });
        }
    });

    console.log(`Found ${itemsToNotify.length} new items (posts/replies) to process.`);
    let totalSent = 0;

    for (const item of itemsToNotify) {
        const { type, post, replyIndex, id, authorId, authorName, group, date, title, body } = item;
        const postId = post._id;

        const logTitle = type === 'reply' ? `Reply on "${title}" by ${authorName}` : `"${title}" by ${authorName}`;
        console.log(`\nProcessing: ${logTitle} (Group: ${group})`);

        // Build list of relevant FCM tokens
        const relevantTokens = [];
        for (const tokenDoc of fcmTokenDocs) {
            const token = tokenDoc.token;
            const uid = String(tokenDoc._id);
            if (!token) continue;

            // Type-specific relevance logic
            let isUserRelevant = false;

            if (type === 'post') {
                if (uid === authorId) {
                    console.log(`  ➡ Skipping token for UID ${uid} (Author of post)`);
                    continue;
                }
                if (uid === 'admin') {
                    isUserRelevant = true;
                } else if (!employeesLoaded) {
                    isUserRelevant = true;
                } else {
                    let employee = employees.find(e => String(e.id || e.mitarbeiter_id) === uid);
                    if (!employee) {
                        const numericId = parseInt(uid.replace(/\D/g, ''), 10);
                        if (!isNaN(numericId)) employee = employees.find(e => parseInt(e.id || e.mitarbeiter_id, 10) === numericId);
                    }
                    if (employee) {
                        isUserRelevant = isRelevant(employee, group, date, groupsState);
                    } else {
                        console.warn(`  ⚠ Token UID ${uid} not found in employees list.`);
                    }
                }
            } else if (type === 'reply') {
                // For replies, notify anyone who's relevant to the post, plus the Post Author.
                const postAuthorId = String(post.mitarbeiterId || post.authorId || '');
                let employee = employees.find(e => String(e.id || e.mitarbeiter_id) === uid);

                if (!employee && uid !== 'admin') {
                    const numericId = parseInt(uid.replace(/\D/g, ''), 10);
                    if (!isNaN(numericId)) employee = employees.find(e => parseInt(e.id || e.mitarbeiter_id, 10) === numericId);
                }

                const empName = employee ? (employee.name || employee.mitarbeiter_name || "") : "";

                // Do not notify the person who just replied
                if (empName === authorName) {
                    console.log(`  ➡ Skipping token for UID ${uid} (Author of reply)`);
                    continue;
                }

                if (uid === 'admin' || (employee && (employee.role === 'Administrator' || empName.toLowerCase() === 'administrator'))) {
                    isUserRelevant = true;
                } else if (uid === postAuthorId) {
                    isUserRelevant = true;
                } else if (!employeesLoaded) {
                    isUserRelevant = true; // Fallback: notify everyone if employee data couldn't load
                } else if (employee) {
                    // Notify anyone relevant to the group, just like the main post
                    isUserRelevant = isRelevant(employee, group, date, groupsState);
                }
            }

            if (isUserRelevant) {
                console.log(`  ➡ Adding token for UID ${uid}`);
                relevantTokens.push(token);
            } else {
                // console.log(`    ❌ Not relevant for this item.`); // Optional detailed logging
            }
        }

        const uniqueTokens = [...new Set(relevantTokens)];
        console.log(`  → ${uniqueTokens.length} relevant recipients`);

        if (uniqueTokens.length === 0) {
            console.log(`  → No relevant recipients found. Skipping notification mark.`);
            // For replies, we still want to mark them as notified even if no tokens were found (e.g. author has no app installed)
            // to avoid reprocessing them endlessly. Posts behave the same way implicitly if no tokens match.
            if (type === 'reply') {
                const updatedReplies = [...post.replies];
                updatedReplies[replyIndex].notifiedAt = new Date().toISOString();
                await firestorePatch(post._ref, { replies: updatedReplies });
                console.log(`  ✅ Marked reply as notified (0 tokens)`);
            }
            continue;
        }

        // Build notification content
        let notifTitle = '';
        let notifBody = '';

        if (type === 'reply') {
            notifTitle = `${authorName} (Antwort)`;
            notifBody = `Zu: ${title}\n"${body}"`;
        } else {
            const preview = body.length > 100 ? body.substring(0, 100) + '...' : body;
            notifTitle = `${authorName}${group ? ` (${group})` : ''}`;
            notifBody = title ? `${title}${preview ? `: ${preview}` : ''}` : (preview || 'Neuer Beitrag im Dienste-Chat');
        }

        // Send to each token
        const cleanupTokens = [];
        let sentForThisItem = 0;
        for (const token of uniqueTokens) {
            const result = await sendFcmPush(accessToken, token, notifTitle, notifBody, postId);
            if (result.success) {
                sentForThisItem++;
                totalSent++;
                console.log(`  ✔ Sent to token ${token.substring(0, 20)}...`);
            } else {
                const errCode = result.error?.error?.status;
                if (errCode === 'UNREGISTERED' || errCode === 'INVALID_ARGUMENT' || errCode === 'NOT_FOUND') {
                    cleanupTokens.push(token);
                }
                console.warn(`  ✗ Failed: ${JSON.stringify(result.error?.error?.message)}`);
            }
        }

        // Cleanup invalid tokens from Firestore
        if (cleanupTokens.length > 0) {
            for (const tokenDoc of fcmTokenDocs) {
                if (cleanupTokens.includes(tokenDoc.token)) {
                    const deleteUrl = `https://firestore.googleapis.com/v1/${tokenDoc._ref}`;
                    await fetch(deleteUrl, { method: 'DELETE' });
                    console.log(`  🗑 Removed invalid token for UID ${tokenDoc._id}`);
                }
            }
        }

        // Mark item as notified
        if (sentForThisItem > 0) {
            if (type === 'post') {
                await firestorePatch(post._ref, { notifiedAt: new Date().toISOString() });
            } else if (type === 'reply') {
                const updatedReplies = [...post.replies];
                updatedReplies[replyIndex].notifiedAt = new Date().toISOString();
                // Firestore API expects arrays to have "arrayValue" with "values". firestorePatch currently handles scalar fields easily but arrays need care.
                // However, firestorePatch helper only handles strings and booleans. Let's send a raw fetch for the array update.

                const arrayValues = updatedReplies.map(r => ({
                    mapValue: {
                        fields: {
                            id: { stringValue: r.id || '' },
                            authorName: { stringValue: r.authorName || '' },
                            body: { stringValue: r.body || '' },
                            createdAt: { stringValue: r.createdAt || '' },
                            ...(r.notifiedAt ? { notifiedAt: { stringValue: r.notifiedAt } } : {})
                        }
                    }
                }));

                const updateUrl = `https://firestore.googleapis.com/v1/${post._ref}?updateMask.fieldPaths=replies`;
                const updateBody = {
                    fields: {
                        replies: {
                            arrayValue: {
                                values: arrayValues
                            }
                        }
                    }
                };

                const updateRes = await fetch(updateUrl, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updateBody)
                });

                if (!updateRes.ok) {
                    console.error("Failed to update reply notifiedAt:", await updateRes.text());
                }
            }
            console.log(`  ✅ Marked as notified (${sentForThisItem} sent)`);
        } else {
            console.log(`  ⚠ Not marking as notified (0 successful sends)`);
        }
    }

    console.log(`\n=== Done. Total push notifications sent: ${totalSent} ===`);
}

main().catch(e => {
    console.error('CRITICAL ERROR:', e);
    process.exit(1);
});
