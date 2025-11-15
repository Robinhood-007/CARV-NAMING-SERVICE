# CARV Naming Service — Frontend (Complete, Live)

This ZIP is the **complete frontend**, already including your latest `App.tsx` from the canvas.

## Setup
1) Open `src/App.tsx` and set your keys:
```ts
const PROGRAM_ID = new PublicKey('REPLACE_WITH_YOUR_DEPLOYED_PROGRAM_ID');
const TREASURY_PUBKEY = new PublicKey('REPLACE_WITH_YOUR_TREASURY_PUBKEY');
```

2) Run locally:
```bash
npm install
npm run dev
# open the URL shown (usually http://localhost:5173/)
```

## Notes
- Backpack wallet only.
- RPC: CARV SVM testnet (already configured).
- Testnet SOL for fees, CARV for payments.
- 7‑day grace message + countdown in the UI.
