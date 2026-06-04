# Privacy Policy for Haps

_Last updated: 2026-06-04_

## Who we are

Haps is an event-discovery app operated by **Daniel Rust** ("Haps App," "we," "us"). You can reach us at **admin@thehaps.app**.

This policy explains what we collect, why, and what you control.

## What we collect

- **Approximate and precise location** — _Why:_ to show you events near you and calculate distance. Used only while the app is open. _Where:_ on your device + cached in our backend during a session if you've signed in.
- **Email address, display name, profile picture** — _Why:_ to create your account and sync your saves across devices. _Where:_ Supabase (our backend host).
- **Saved events, dismissed events, check-ins** — _Why:_ to keep your favorites and history in sync. _Where:_ Supabase + your device.
- **Events you submit** — if you use the "Submit Event" feature, the event details you enter (such as title, description, time, and venue) plus a link to your account, so we can review and publish them. _Where:_ Supabase.
- **Device identifiers (Supabase session tokens)** — _Why:_ to keep you signed in. _Where:_ on your device only (hardware-encrypted: Android Keystore / iOS Keychain).
- **An app-generated device ID** (random, not a hardware/advertising ID) — _Why:_ to keep your saves and check-ins working before you sign in. _Where:_ your device + our backend (Supabase).
- **Anonymous usage analytics** — _Why:_ to understand how the app is used so we can improve it: things like app opens, feed loads, swipes (saved vs. passed), category interest, searches, screens opened, and errors. _Where:_ our own backend (Supabase). No names, emails, or message content — events are tied only to your app user ID, which is anonymous until you choose to sign in, and are **de-identified if you delete your account**. **Any location in analytics is coarsened on your device to roughly a 1 km area** — we never store a precise coordinate in analytics. You can turn this off anytime in **Settings → "Share usage data."**
- **App diagnostics (crash reports)** — we do not currently collect crash reports.

We do **not** collect:

- Contacts, photos, microphone, or camera input
- Advertising identifiers (IDFA, GAID)
- Browsing history outside the app
- Your calendar contents — "Add to Calendar" only *writes* an event you chose to add; we never read your calendar
- Anything you haven't explicitly given the app permission to access

## How we use it

To make the app work — showing you events, syncing your saves between your phones, signing you in — and to understand how it's used so we can improve it (see **Anonymous usage analytics** above). We process usage analytics ourselves on our own backend; we do not sell your data, we do not run ads in the app, and we do not share data with brokers, advertisers, or third-party analytics resellers. You can opt out of usage analytics in **Settings → "Share usage data"** at any time without losing any app features.

## Third-party services

Haps uses these providers; each has its own privacy policy:

- **Supabase** (database, authentication) — https://supabase.com/privacy
- **Google Maps SDK** (map display) — https://policies.google.com/privacy
- **Google Sign-In** (login option) — same as above
- **Sign in with Apple** (login option) — https://www.apple.com/legal/privacy/
- **Gemini API by Google** (categorizes scraped events, server-side only — never sees your data) — https://policies.google.com/privacy

If you sign in with one of the OAuth options, that provider tells us your name, email, and profile picture. They may also log the sign-in event on their side.

## Data retention

- **Your account data** (email, saves, dismisses, check-ins): kept until you delete your account.
- **Usage analytics** (app opens, feed loads, swipes, searches, errors): retained to track product trends over time. Events are tied to your app user ID, which is de-identified (unlinked from you) if you delete your account. Location in analytics is only ever a coarse ~1 km area, never a precise coordinate — and nothing is collected if you've opted out.
- **Location**: precise location is not retained beyond the current session.

## Your rights

You can:

- **See or export your data** — email admin@thehaps.app and we'll send you everything we have on you within 30 days.
- **Delete your account and all associated data** — email the same address.
- **Stop sharing location** — revoke the permission in your phone's Settings; the app will keep working but events won't show distance/sort by distance.
- **Turn off usage analytics** — Settings → "Share usage data." The app keeps working exactly the same.
- **Sign out** — use the sign-out option in the app's Settings.

Residents of California (CCPA), the EU/UK (GDPR), or other jurisdictions with data-protection laws have additional rights. Contact us and we will honor them.

## Children

Haps is not directed at children under 13. We do not knowingly collect data from anyone under 13. If you believe a child has provided data to us, email us and we'll delete it.

## Security

Data in transit between the app and our backend is encrypted (HTTPS/TLS). Account data at rest in Supabase is encrypted by Supabase's infrastructure. We use OAuth providers for sign-in, so we never see your password.

That said, no system is perfect. If a breach affects your data, we'll notify you within 72 hours of becoming aware of it, where required by law.

## Changes to this policy

If we change how we handle data, we'll post the updated policy here and update the date at the top. Material changes (new categories of data, new sharing partners) will prompt an in-app notice.

## Content removal

Haps aggregates publicly available event listings to help users discover things to do. If you are an event organizer, venue operator, or content owner and would like your events or content removed from Haps, please email **admin@thehaps.app** with the details and we will remove the content promptly, typically within 48 hours.

## Contact

All inquiries — privacy requests, content removal, data export, account deletion, DMCA notices, or general questions:

**admin@thehaps.app**
