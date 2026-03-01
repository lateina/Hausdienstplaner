const nodemailer = require('nodemailer');

const JSONBIN_KEY = process.env.JSONBIN_KEY;
const CHAT_BIN_ID = process.env.CHAT_BIN_ID;
const EMP_BIN_ID = process.env.EMP_BIN_ID;

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = process.env.SMTP_PORT || 465;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER;

async function checkAndSendReminders() {
    console.log("Starting Reminder Check (Gmail SMTP)...");

    if (!JSONBIN_KEY || !SMTP_USER || !SMTP_PASS) {
        console.error("Missing required environment variables (JSONBIN_KEY, SMTP_USER, or SMTP_PASS). Aborting.");
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
        const employees = Array.isArray(empData.record) ? empData.record :
            (empData.record.employees || empData.record.mitarbeiter || Object.values(empData.record).find(val => Array.isArray(val)) || []);

        // 3. Setup Nodemailer
        const transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_PORT == 465,
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASS
            }
        });

        const now = new Date();
        now.setHours(0, 0, 0, 0);

        let emailsSent = 0;

        // 4. Check Posts
        for (const post of posts) {
            if (post.isDone) continue;
            if (!post.targetDate) continue;

            const targetDate = new Date(post.targetDate);
            targetDate.setHours(0, 0, 0, 0);

            const diffTime = targetDate.getTime() - now.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays === 7) {
                let authorEmail = null;
                const authorId = post.mitarbeiterId || post.authorId;

                if (authorId) {
                    const emp = employees.find(e => String(e.id || e.mitarbeiter_id) === String(authorId));
                    if (emp) authorEmail = emp.email || emp.mitarbeiter_email;
                }

                if (!authorEmail) {
                    const emp = employees.find(e => {
                        const ename = e.name || e.mitarbeiter_name;
                        return ename && ename === post.authorName;
                    });
                    if (emp) authorEmail = emp.email || emp.mitarbeiter_email;
                }

                if (authorEmail) {
                    const group = post.tags && post.tags[0] ? ` (${post.tags[0]})` : '';
                    console.log(`Sending email via SMTP to ${authorEmail} for post ID ${post.id}`);

                    try {
                        await transporter.sendMail({
                            from: EMAIL_FROM,
                            to: authorEmail,
                            bcc: EMAIL_FROM,
                            subject: `Erinnerung: Tauschgesuch für deinen Dienst am ${targetDate.toLocaleDateString('de-DE')} ist noch offen`,
                            text: `Hallo ${post.authorName},\n\ndein Dienst${group} am ${targetDate.toLocaleDateString('de-DE')} ist in genau 7 Tagen fällig, aber dein Tauschgesuch ("${post.title}") ist im Dienste-Chat aktuell noch offen / nicht als erledigt markiert.\n\nFalls du den Dienst inzwischen tauschen konntest, logge dich bitte kurz ins Message Board ein und markiere das Gesuch als "Erledigt".\n\nViele Grüße\nDein Dienste-Chat Bot`
                        });
                        emailsSent++;
                    } catch (err) {
                        console.error('Error sending email via SMTP:', err);
                    }
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
