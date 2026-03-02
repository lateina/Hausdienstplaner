const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

exports.onNewPost = onDocumentCreated("posts/{postId}", async (event) => {
    const post = event.data.data();
    const postId = event.params.postId;

    console.log(`New post detected: ${postId} by ${post.authorName}`);

    // 1. Get all registered FCM tokens
    const tokensSnapshot = await db.collection("fcm_tokens").get();
    const allTokens = [];
    tokensSnapshot.forEach(doc => {
        if (doc.data().token) allTokens.push(doc.data().token);
    });

    const tokens = [...new Set(allTokens)];

    if (tokens.length === 0) {
        console.log("No FCM tokens found.");
        return null;
    }

    // 2. Construct the message
    const message = {
        notification: {
            title: `${post.authorName} hat etwas gepostet`,
            body: post.title || "Neuer Beitrag im Dienste-Chat",
        },
        data: {
            postId: postId,
        },
        tokens: tokens,
    };

    // 3. Send via FCM
    try {
        const response = await messaging.sendEachForMulticast(message);
        console.log(`Successfully sent ${response.successCount} messages.`);

        // Clean up invalid tokens
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    console.log(`Token ${tokens[idx]} failed: ${resp.error.code}`);
                    failedTokens.push(tokensSnapshot.docs[idx].ref.delete());
                }
            });
            await Promise.all(failedTokens);
        }
    } catch (error) {
        console.error("Error sending message:", error);
    }
    return null;
});
