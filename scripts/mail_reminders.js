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
    console.log("--- Starting Reminder Check (Gmail SMTP) ---");

    if (!JSONBIN_KEY || !SMTP_USER || !SMTP_PASS) {
        console.error("CRITICAL: Missing required environment variables (JSONBIN_KEY, SMTP_USER, or SMTP_PASS).");
        process.exit(1);
    }

    try {
        // 1. Fetch Chat Posts
        console.log(`Step 1: Fetching Chat data from bin: ${CHAT_BIN_ID}`);
        const chatRes = await fetch(`https://api.jsonbin.io/v3/b/${CHAT_BIN_ID}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        const chatData = await chatRes.json();

        if (!chatRes.ok) {
            console.error("ERROR: Failed to fetch Chat data:", chatData);
            throw new Error(`Chat API error: ${chatRes.status}`);
        }

        const posts = (chatData.record && chatData.record.posts) || [];
        console.log(`LOG: Successfully loaded ${posts.length} posts from chat board.`);

        // 2. Fetch Employee Emails
        console.log(`Step 2: Fetching Employee/Email data from bin: ${EMP_BIN_ID}`);
        const empRes = await fetch(`https://api.jsonbin.io/v3/b/${EMP_BIN_ID}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        const empData = await empRes.json();

        if (!empRes.ok) {
            console.error("ERROR: Failed to fetch Employee email data:", empData);
            throw new Error(`Employee API error: ${empRes.status}`);
        }

        const employees = Array.isArray(empData.record) ? empData.record :
            (empData.record.employees || empData.record.mitarbeiter || Object.values(empData.record).find(val => Array.isArray(val)) || []);

        console.log(`LOG: Employee email database contains ${employees.length} entries.`);

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
        console.log(`LOG: Reference date (Today): ${now.toLocaleDateString('de-DE')}`);

        let emailsSent = 0;

        // 4. Check Posts
        for (const post of posts) {
            if (post.isDone) continue;
            if (!post.targetDate) continue;

            const targetDate = new Date(post.targetDate);
            targetDate.setHours(0, 0, 0, 0);

            const diffTime = targetDate.getTime() - now.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            // Remind exactly 7 days before
            if (diffDays === 7) {
                console.log(`\n>>> Match Found! Post "${post.title}" is due in 7 days (${targetDate.toLocaleDateString('de-DE')})`);

                let authorEmail = null;
                const authorId = post.mitarbeiterId || post.authorId;
                const authorName = post.authorName;

                console.log(`DEBUG: Searching for email for Author: "${authorName}" (ID: ${authorId})`);

                // 4a. Try Match by ID
                if (authorId) {
                    const emp = employees.find(e => {
                        const empId = e.id || e.mitarbeiter_id;
                        return String(empId) === String(authorId);
                    });
                    if (emp) {
                        authorEmail = emp.email || emp.mitarbeiter_email;
                        if (authorEmail) console.log(`DEBUG: Found email by ID match: ${authorEmail}`);
                    }
                }

                // 4b. Fallback: Try Match by Name (Case-Insensitive)
                if (!authorEmail && authorName) {
                    const emp = employees.find(e => {
                        const ename = (e.name || e.mitarbeiter_name || "").trim().toLowerCase();
                        return ename === authorName.trim().toLowerCase();
                    });
                    if (emp) {
                        authorEmail = emp.email || emp.mitarbeiter_email;
                        if (authorEmail) console.log(`DEBUG: Found email by Name fallback match: ${authorEmail}`);
                    }
                }

                if (authorEmail) {
                    const group = post.tags && post.tags[0] ? ` (${post.tags[0]})` : '';
                    console.log(`ACTION: Sending email to ${authorEmail}...`);

                    try {
                        await transporter.sendMail({
                            from: EMAIL_FROM,
                            to: authorEmail,
                            bcc: EMAIL_FROM,
                            subject: `Erinnerung: Tauschgesuch für deinen Dienst am ${targetDate.toLocaleDateString('de-DE')} ist noch offen`,
                            text: `Hallo ${post.authorName},\n\ndein Dienst${group} am ${targetDate.toLocaleDateString('de-DE')} ist in genau 7 Tagen fällig, aber dein Tauschgesuch ("${post.title}") ist im Dienste-Chat aktuell noch offen / nicht als erledigt markiert.\n\nFalls du den Dienst inzwischen tauschen konntest, logge dich bitte kurz ins Message Board ein und markiere das Gesuch als "Erledigt".\n\nViele Grüße\nDein Dienste-Chat Bot`
                        });
                        console.log(`SUCCESS: Email sent to ${authorEmail}`);
                        emailsSent++;
                    } catch (err) {
                        console.error(`ERROR: Failed to send email to ${authorEmail}:`, err.message);
                    }
                } else {
                    console.warn(`WARNING: Could not find email address for "${authorName}" (ID: ${authorId}).`);
                    // List first 3 employees for debugging
                    console.log("DEBUG: Available employees in database (sample):", JSON.stringify(employees.slice(0, 3).map(e => ({ name: e.name || e.mitarbeiter_name, id: e.id || e.mitarbeiter_id })), null, 2));
                }
            }
        }
        console.log(`\n--- Completed. Total emails sent: ${emailsSent} ---`);
    } catch (e) {
        console.error("CRITICAL ERROR during execution:", e);
        process.exit(1);
    }
}

checkAndSendReminders();
