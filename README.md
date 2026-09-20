# Gold Trader (Capital.com, semi-automatic)

## Setup
1. Capital.com: Settings > API integrations > generate an API key (set a custom password for it). Start on a DEMO account.
2. Deploy this folder to a Node host (Render / Railway / Fly.io). Start command: `npm start`.
3. Set environment variables:
   CAPITAL_API_KEY, CAPITAL_EMAIL, CAPITAL_PASSWORD (API key password), APP_PIN (your own PIN), MODE=demo
4. Open the URL in iPhone Safari > Share > Add to Home Screen.

## Daily use
- Each day open the app, set the quantity (e.g. 0.01). It locks after the first trade that day.
- App scans every minute during 07:00-20:00 UTC. When a signal shows, tap Execute.
- Max 5 trades/day, one gold position at a time, SL 20 / TP 40 on every order.
- Switch MODE=live only after weeks of demo results.
