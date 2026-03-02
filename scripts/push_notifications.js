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
            notification: { title, body },
            data: { postId: String(postId), type: 'new_post' },
            webpush: {
                headers: { Urgency: 'high' },
                fcm_options: {
                    link: `https://lateina.github.io/Hausdienstchat/index.html?post=${postId}`
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

function nameMatch(n, userName) {
    if (!n) return false;
    const cleanDistName = normalize(typeof n === 'object' ? (n.name || n.mitarbeiter_name || '') : n);
    const cleanUserName = normalize(userName);
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
    if (role === 'Administrator' || name === 'administrator') return true;
    if (!postGroup) return true;

    for (const type of ['hausdienst', 'visits']) {
        const state = groupsState[type];
        let distributions = state.assignments || state.distributions || state || {};

        if (postDate) {
            const dateObj = new Date(postDate);
            const monatId = `month_${dateObj.getFullYear()}_${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
            const month = (state.months || []).find(m => m.monat_id === monatId);
            if (month && (month.distributions || month.assignments)) {
                distributions = month.distributions || month.assignments;
            }
        }

        const reverseLabels = { 'Station 46': 'visite_46', 'Station 18': 'visite_18', 'Station 19': 'visite_19' };
        const searchKey = reverseLabels[postGroup] || postGroup;
        const assigned = distributions[searchKey];
        if (assigned) {
            const names = Array.isArray(assigned) ? assigned : [assigned];
            if (names.some(n => nameMatch(n, name))) return true;
        }
        const pool = distributions['pool'];
        if (pool) {
            const poolNames = Array.isArray(pool) ? pool : [pool];
            if (poolNames.some(n => nameMatch(n, name))) {
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
    const employeesLoaded = employees.length > 0;
    console.log(`Loaded: ${employees.length} employees, ${fcmTokenDocs.length} FCM tokens`);

    // 2. Get FCM access token
    let accessToken;
    try {
        accessToken = await getFcmAccessToken();
    } catch (e) {
        console.error('CRITICAL: Could not get FCM access token:', e.message);
        process.exit(1);
    }

    // 3. Find new posts that haven't been notified yet
    const newPosts = posts.filter(p => {
        if (p.notifiedAt) return false; // Already notified
        if (!p.createdAt) return false;
        return p.createdAt > cutoff;
    });

    console.log(`Found ${newPosts.length} new posts to process.`);
    let totalSent = 0;

    for (const post of newPosts) {
        const postId = post._id;
        const postGroup = post.tags && post.tags[0] ? post.tags[0] : null;
        const postDate = post.targetDate || null;
        const authorName = post.authorName || '';

        console.log(`\nProcessing: "${post.title}" by ${authorName} (Group: ${postGroup})`);

        // Build list of relevant FCM tokens
        const relevantTokens = [];
        for (const tokenDoc of fcmTokenDocs) {
            const token = tokenDoc.token;
            const uid = tokenDoc._id;
            if (!token) continue;

            if (uid === 'admin') {
                relevantTokens.push(token);
                continue;
            }

            if (!employeesLoaded) {
                relevantTokens.push(token);
                continue;
            }

            let employee = employees.find(e => String(e.id || e.mitarbeiter_id) === String(uid));
            if (!employee) {
                const numericId = parseInt(uid.replace(/\D/g, ''), 10);
                if (!isNaN(numericId)) {
                    employee = employees.find(e => parseInt(e.id || e.mitarbeiter_id, 10) === numericId);
                }
            }
            if (!employee) continue;

            if (isRelevant(employee, postGroup, postDate, groupsState)) {
                relevantTokens.push(token);
            }
        }

        const uniqueTokens = [...new Set(relevantTokens)];
        console.log(`  → ${uniqueTokens.length} relevant recipients`);

        if (uniqueTokens.length === 0) {
            console.log(`  → No relevant recipients found. Skipping notification mark.`);
            continue;
        }

        // Build notification content
        const preview = (post.body || '').length > 100 ? (post.body || '').substring(0, 100) + '...' : (post.body || '');
        const notifTitle = `${authorName}${postGroup ? ` (${postGroup})` : ''}`;
        const notifBody = post.title ? `${post.title}${preview ? `: ${preview}` : ''}` : (preview || 'Neuer Beitrag im Dienste-Chat');

        // Send to each token
        const cleanupTokens = [];
        for (const token of uniqueTokens) {
            const result = await sendFcmPush(accessToken, token, notifTitle, notifBody, postId);
            if (result.success) {
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

        // Mark post as notified
        await firestorePatch(post._ref, { notifiedAt: new Date().toISOString() });
    }

    console.log(`\n=== Done. Total push notifications sent: ${totalSent} ===`);
}

main().catch(e => {
    console.error('CRITICAL ERROR:', e);
    process.exit(1);
});
