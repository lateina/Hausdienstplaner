const { Resend } = require('resend');

const JSONBIN_KEY = process.env.JSONBIN_KEY;
const CHAT_BIN_ID = process.env.CHAT_BIN_ID;
const EMP_BIN_ID = process.env.EMP_BIN_ID;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function checkAndSendReminders() {
    console.log("Starting Reminder Check...");

    if (!JSONBIN_KEY || !RESEND_API_KEY) {
        console.error("Missing required environment variables (JSONBIN_KEY or RESEND_API_KEY). Aborting.");
        process.exit(1);
    }

    try {
        // 1. Fetch Chat Posts
        const chatRes = await fetch(`https://api.jsonbin.io/v3/b/${CHAT_BIN_ID}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        const chatData = await chatRes.json();
        const posts = chatData.record.posts || [];

        // 2. Fetch Employee Emails
        const empRes = await fetch(`https://api.jsonbin.io/v3/b/${EMP_BIN_ID}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        const empData = await empRes.json();

        // Handle various JSON structures in the employee bin
        const employees = Array.isArray(empData.record) ? empData.record :
            (empData.record.employees || empData.record.mitarbeiter || Object.values(empData.record).find(val => Array.isArray(val)) || []);

        // 3. Setup Resend
        const resend = new Resend(RESEND_API_KEY);

        const now = new Date();
        now.setHours(0, 0, 0, 0);

        let emailsSent = 0;

        // 4. Check Posts
        for (const post of posts) {
            // Skip if done or no date
            if (post.isDone) continue;
            if (!post.targetDate) continue;

            const targetDate = new Date(post.targetDate);
            targetDate.setHours(0, 0, 0, 0);

            const diffTime = targetDate.getTime() - now.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            // We want to remind EXACTLY 7 days before
            if (diffDays === 7) {
                // Find Author's Email
                let authorEmail = null;
                const authorId = post.mitarbeiterId || post.authorId;

                if (authorId) {
                    const emp = employees.find(e => String(e.id || e.mitarbeiter_id) === String(authorId));
                    if (emp) authorEmail = emp.email || emp.mitarbeiter_email;
                }

                // Fallback: search by name
                if (!authorEmail) {
                    const emp = employees.find(e => {
                        const ename = e.name || e.mitarbeiter_name;
                        return ename && ename === post.authorName;
                    });
                    if (emp) authorEmail = emp.email || emp.mitarbeiter_email;
                }

                if (authorEmail) {
                    const group = post.tags && post.tags[0] ? ` (${post.tags[0]})` : '';

                    console.log(`Sending email via Resend to ${authorEmail} for post ID ${post.id}`);

                    try {
                        const data = await resend.emails.send({
                            from: 'Hausdienst-Bot <onboarding@resend.dev>',
                            to: authorEmail,
                            subject: `Erinnerung: Tauschgesuch für deinen Dienst am ${targetDate.toLocaleDateString('de-DE')} ist noch offen`,
                            text: `Hallo ${post.authorName},\n\ndein Dienst${group} am ${targetDate.toLocaleDateString('de-DE')} ist in genau 7 Tagen fällig, aber dein Tauschgesuch ("${post.title}") ist im Dienste-Chat aktuell noch offen / nicht als erledigt markiert.\n\nFalls du den Dienst inzwischen tauschen konntest, logge dich bitte kurz ins Message Board ein und markiere das Gesuch als "Erledigt".\n\nViele Grüße\nDein Dienste-Chat Bot`
                        });
                        console.log("Success:", data);
                        emailsSent++;
                    } catch (err) {
                        console.error('Error sending email via Resend API:', err);
                    }
                } else {
                    console.warn(`Could not find an email address for post author: ${post.authorName} (ID: ${authorId})`);
                }
            }
        }

        console.log(`Reminder check completed. Sent ${emailsSent} emails.`);

    } catch (e) {
        console.error("Error during reminder check:", e);
        process.exit(1);
    }
}

checkAndSendReminders();
