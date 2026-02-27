# Hausdienstchat Walkthrough

The Hausdienstchat is a lightweight, secure message board designed for assistant doctors to coordinate house service swaps and view their current service assignments.

## Features

### 1. Secure Authentication
- Users log in by selecting their name from a dropdown and entering their unique PIN.
- The employee data (names, emails, PINs) is fetched securely from a dedicated JSONBin.io bin.

### 2. Tauschbörse (Message Board)
- A simple feed where doctors can post "Tauschwünsche" (swap requests).
- Supports subjects, message bodies, and tagging specific service groups (e.g., "Station 46").
- Doctors can reply to posts to discuss potential swaps.

### 3. Dienstgruppen View
- Displays the current distribution of employees across various stations and service groups.
- Data is pulled from the planer distribution bin, ensuring doctors always see the most up-to-date assignments.

### 4. Admin Monitoring
- Users with the "Administrator" role can:
    - Oversee all posts and comments.
    - Mark new posts as "Gelesen" (Seen) with a visual indicator.
    - Delete inappropriate or outdated posts.

## User Interface

### Login Screen
![Login Screen Mockup](https://raw.githubusercontent.com/Antigravity-AI/media/main/hausdienstchat_login.png)
*Modern, clean login interface with name selection and PIN entry.*

### Dashboard Overview
![Dashboard Overview](https://raw.githubusercontent.com/Antigravity-AI/media/main/hausdienstchat_dashboard.png)
*The main dashboard showing the Tauschbörse and navigation tabs.*

## Technical Details

- **Store**: Uses `localStorage` to persist the session, API keys, and Bin IDs.
- **Persistence**: Powered by `JSONBin.io` with multiple bins for employees, distributions, and chat messages.
- **Styling**: Premium look using Inter font, glassmorphism, and responsive CSS.

## Setup Instructions

1. Ensure the `Hausdienstchat` folder is synced via Dropbox.
2. Open `index.html` in any modern browser.
3. On first load, enter your JSONBin API-Key when prompted.
4. (Optional) The user can update the specific Bin IDs in the code or via `localStorage` if needed.
