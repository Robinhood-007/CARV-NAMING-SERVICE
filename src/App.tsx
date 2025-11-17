import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Buffer } from 'buffer';
import process from 'process';
(window as any).global = window;
(window as any).Buffer = (window as any).Buffer || Buffer;
(window as any).process = (window as any).process || process;
import * as anchor from '@coral-xyz/anchor';
import {
  PublicKey,
  SystemProgram,
  Connection,
  Transaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
  getAccount,
} from '@solana/spl-token';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import bs58 from 'bs58';

/** ===== Constants / ENV ===== */
// Reads from .env; supports "/rpc" dev proxy and full https:// URL in prod
const RAW_RPC = (import.meta as any).env?.VITE_RPC_ENDPOINT ?? 'https://rpc.testnet.carv.io';
const RPC_ENDPOINT = import.meta.env.VITE_CARV_RPC_URL || 'https://rpc.testnet.carv.io/rpc';
const CARV_MINT = new PublicKey('D7WVEw9Pkf4dfCCE3fwGikRCCTvm9ipqTYPHRENLiw3s');

// Read from Vite env. (we no longer show the preview/config banners)
const PROGRAM_ID_STR = (import.meta as any).env?.VITE_PROGRAM_ID || 'REPLACE_WITH_YOUR_DEPLOYED_PROGRAM_ID';
const TREASURY_PUBKEY_STR = (import.meta as any).env?.VITE_TREASURY || 'REPLACE_WITH_YOUR_TREASURY_PUBKEY';
const PREVIEW_MODE = ((import.meta as any).env?.VITE_PREVIEW === '1'); // unused for banners now

const safePk = (s: string): PublicKey | null => { try { return new PublicKey(s); } catch { return null; } };
const PROGRAM_ID = safePk(PROGRAM_ID_STR);
const TREASURY_PUBKEY = safePk(TREASURY_PUBKEY_STR);
const HAS_CONFIG = !!PROGRAM_ID && !!TREASURY_PUBKEY;

const GRACE_SECS = 7 * 24 * 60 * 60;

/** ===== Minimal IDL (client) ===== */
const IDL = {
  version: '0.1.0',
  name: 'carv_naming_service',
  instructions: [
    {
      name: 'register',
      accounts: [
        { name: 'payer', isMut: true, isSigner: true },
        { name: 'nameRecord', isMut: true, isSigner: false },
        { name: 'treasury', isMut: false, isSigner: false },
        { name: 'payerAta', isMut: true, isSigner: false },
        { name: 'treasuryAta', isMut: true, isSigner: false },
        { name: 'carvMint', isMut: false, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'name', type: 'string' },
        { name: 'years', type: 'u8' },
        { name: 'nameSeed', type: { array: ['u8', 32] } }, // <-- hashed seed
      ],
    },
    { name: 'transfer_name', accounts: [{ name: 'owner', isMut: true, isSigner: true }, { name: 'nameRecord', isMut: true, isSigner: false }], args: [{ name: 'name', type: 'string' }, { name: 'newOwner', type: 'publicKey' }] },
    { name: 'set_resolver', accounts: [{ name: 'owner', isMut: true, isSigner: true }, { name: 'nameRecord', isMut: true, isSigner: false }], args: [{ name: 'name', type: 'string' }, { name: 'newResolver', type: 'publicKey' }] },
    { name: 'set_primary', accounts: [{ name: 'owner', isMut: true, isSigner: true }, { name: 'nameRecord', isMut: false, isSigner: false }, { name: 'reverseRecord', isMut: true, isSigner: false }, { name: 'systemProgram', isMut: false, isSigner: false }], args: [{ name: 'name', type: 'string' }] },
  ],
  accounts: [
    { name: 'NameRecord', type: { kind: 'struct', fields: [{ name: 'name', type: 'string' }, { name: 'owner', type: 'publicKey' }, { name: 'resolver', type: 'publicKey' }, { name: 'createdAt', type: 'i64' }, { name: 'expiresAt', type: 'i64' }, { name: 'initialized', type: 'bool' }] } },
    { name: 'ReverseRecord', type: { kind: 'struct', fields: [{ name: 'name', type: 'string' }, { name: 'setAt', type: 'i64' }] } },
  ],
} as const;
const ACCOUNTS_CODER = new anchor.BorshAccountsCoder(IDL as any);

/** ===== Backpack-only wallet hook ===== */
type BackpackSolana = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  publicKey: PublicKey | null;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
};
declare global { interface Window { backpack?: { solana?: BackpackSolana } } }

function useBackpack(connection: Connection) {
  const [provider, setProvider] = useState<BackpackSolana | null>(null);
  const [pubkey, setPubkey] = useState<PublicKey | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      if (window.backpack?.solana) {
        setProvider(window.backpack.solana);
        clearInterval(interval);
      }
    }, 100);
    return () => clearInterval(interval);
  }, []);

  const connect = async () => {
    if (!provider) throw new Error('Backpack wallet not found. Please install/open Backpack.');
    await provider.connect();
    setPubkey(provider.publicKey);
  };

  const disconnect = async () => {
    await provider?.disconnect();
    setPubkey(null);
  };

  const sendTx = async (tx: Transaction): Promise<string> => {
    if (!provider?.publicKey) throw new Error('Connect Backpack first.');
    tx.feePayer = provider.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    const signed = await provider.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  };

  return { pubkey, connect, disconnect, sendTx, isInstalled: !!provider };
}

}

/** ===== Utilities ===== */
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const pkBytes = (pk: PublicKey) =>
  (typeof (pk as any).toBytes === 'function' ? (pk as any).toBytes() : (pk as any).toBuffer());

const pricePerYear = (name: string): number => {
  const n = [...name].length;
  if (n < 3) return 0;
  if (n === 3) return 1600;
  if (n === 4) return 400;
  if (n === 5) return 200;
  if (n === 6) return 100;
  return 20;
};
const isValidNameCore = (s: string) => /^[a-z0-9-]{3,64}$/.test(s);
const stripSuffix = (s: string) => s.replace(/\.carv$/i, '');
const isValidName = (s: string) => isValidNameCore(stripSuffix(s));
const utf8ByteLen = (s: string) => new TextEncoder().encode(s).length;

const explorerTx = (sig: string) => {
  const custom = encodeURIComponent(RPC_ENDPOINT);
  return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${custom}`;
};
const explorerAccount = (pk: PublicKey) => {
  const custom = encodeURIComponent(RPC_ENDPOINT);
  return `https://explorer.solana.com/address/${pk.toBase58()}?cluster=custom&customUrl=${custom}`;
};

// ----- PDA helpers (use SHA-256(lowercase(name)) seed) -----
async function nameSeed32(nameLower: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(nameLower);
  const digest = await crypto.subtle.digest('SHA-256', data); // ArrayBuffer
  return new Uint8Array(digest); // length 32
}

async function namePdaWithSeed(raw: string): Promise<[PublicKey, number]> {
  const lower = raw.toLowerCase();
  const seed = await nameSeed32(lower);
  return PublicKey.findProgramAddressSync([bytes('cns'), seed], PROGRAM_ID!);
}

const reversePda = (owner: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([bytes('reverse'), pkBytes(owner)], PROGRAM_ID!);
// ---------------------------------------------

// Anchor account discriminator via WebCrypto
async function accountDiscriminator(name: string): Promise<Uint8Array> {
  const preimage = enc.encode(`account:${name}`);
  const subtle: SubtleCrypto | undefined = (globalThis as any)?.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto SubtleCrypto is unavailable.');
  const hash = await subtle.digest('SHA-256', preimage);
  return new Uint8Array(hash).slice(0, 8);
}

/** ===== Types ===== */
type LookupState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available' }
  | { status: 'grace'; owner: string; resolver: string; expiresAt: number; graceEndsAt: number; isYours: boolean }
  | { status: 'expired'; owner: string; resolver: string; expiresAt: number }
  | { status: 'taken'; owner: string; resolver: string; expiresAt: number; isYours: boolean }
  | { status: 'error'; message: string };

type MyName = {
  pda: PublicKey;
  name: string;
  resolver: string;
  expiresAt: number;
  status: 'active' | 'grace' | 'expired';
  isPrimary: boolean;
};

/* ===== Wallet dropdown ===== */
function WalletMenu({
  pubkey,
  connect,
  disconnect,
  onViewNames,
  setMessage,
}: {
  pubkey: PublicKey | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  onViewNames: () => void;
  setMessage: (s: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const short = (s: string) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : '');

  React.useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open) return;
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const copyAddress = async () => {
    const addr = pubkey?.toBase58();
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setMessage('Address copied');
    } catch {
      setMessage('Unable to copy address');
    } finally {
      setTimeout(() => setMessage(null), 1500);
    }
  };

  if (!pubkey) {
    return (
      <button ref={buttonRef} className="btn btn-primary" onClick={() => connect()}>
        Connect Wallet
      </button>
    );
  }

  const address = pubkey.toBase58();
  return (
    <div className="wallet-menu" style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        className="btn btn-primary wallet-button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {short(address)}
        <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true" style={{ marginLeft: 6 }}>
          <path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="wallet-dropdown"
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: '110%',
            minWidth: 180,
            padding: 8,
            borderRadius: 12,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            boxShadow: '0 8px 40px rgba(0,0,0,.35)',
            zIndex: 50,
          }}
        >
          <button className="menu-item" onClick={copyAddress} role="menuitem" style={{ width: '100%' }}>
            Copy Address
          </button>
          <button
            className="menu-item"
            onClick={() => { setOpen(false); onViewNames(); }}
            role="menuitem"
            style={{ width: '100%' }}
          >
            View Names
          </button>
          <div className="menu-sep" style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
          <button
            className="menu-item danger"
            onClick={() => { setOpen(false); disconnect(); }}
            role="menuitem"
            style={{ width: '100%', color: '#ff6b6b' }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

/** ===== App Root (with Router) ===== */
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="btn btn-ghost"
      onClick={onClick}
      aria-label="Back to home"
      title="Back to home"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10 }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <span>Back</span>
    </button>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppInner />
    </BrowserRouter>
  );
}

function AppInner() {
  const connection = useMemo(() => new Connection(RPC_ENDPOINT, 'confirmed'), []);
  const { pubkey, connect, disconnect, sendTx } = useBackpack(connection);
  const navigate = useNavigate();
  const location = useLocation();
  const onRegistrarPage = location.pathname === '/register';

  // Theme
  const [mode, setMode] = useState<'light' | 'dark'>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  );
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark');
    if (mode === 'dark') root.classList.add('dark');
  }, [mode]);

  const [name, setName] = useState('');
  const [years, setYears] = useState(1);
  const [decimals, setDecimals] = useState<number | null>(null);
  const [tokenProgramId, setTokenProgramId] = useState(TOKEN_PROGRAM_ID);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);

  // balances
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [carvBalance, setCarvBalance] = useState<number | null>(null);

  // availability
  const [lookup, setLookup] = useState<LookupState>({ status: 'idle' });

  // portfolio
  const [myNames, setMyNames] = useState<MyName[] | null>(null);
  const [loadingMyNames, setLoadingMyNames] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);

  const [nowTs, setNowTs] = useState<number>(Math.floor(Date.now() / 1000));
  useEffect(() => { const id = setInterval(() => setNowTs(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(id); }, []);

  // detect mint & decimals
  useEffect(() => {
    (async () => {
      try {
        const info = await connection.getAccountInfo(CARV_MINT, 'confirmed');
        const programId = info?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        setTokenProgramId(programId);
        const mint = await getMint(connection, CARV_MINT, 'confirmed', programId);
        setDecimals(mint.decimals);
      } catch {
        setMessage('Unable to fetch CARV mint info.');
      }
    })();
  }, [connection]);

  const refreshBalances = useCallback(async () => {
    if (!pubkey) { setSolBalance(null); setCarvBalance(null); return; }
    try {
      const lamports = await connection.getBalance(pubkey, 'confirmed');
      setSolBalance(lamports / LAMPORTS_PER_SOL);
    } catch { setSolBalance(null); }
    try {
      const ata = await getAssociatedTokenAddress(CARV_MINT, pubkey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
      const info = await connection.getAccountInfo(ata, 'confirmed');
      if (!info) setCarvBalance(0);
      else {
        const acct: any = await getAccount(connection, ata, 'confirmed', tokenProgramId);
        const raw = typeof acct.amount === 'bigint' ? Number(acct.amount) : Number(acct.amount);
        setCarvBalance(raw / Math.pow(10, decimals ?? 0));
      }
    } catch { setCarvBalance(null); }
  }, [pubkey, connection, tokenProgramId, decimals]);
  useEffect(() => { refreshBalances().catch(() => {}); }, [refreshBalances]);

  // derived for register panel
  const normalized = stripSuffix(name.trim().toLowerCase());
  const perYear = pricePerYear(normalized);
  const totalCarv = years * perYear;
  const fullLabel = normalized ? `${normalized}.carv` : '';

  // anchor program
  const program = useMemo(() => {
    if (!pubkey || !HAS_CONFIG || !PROGRAM_ID) return null;
    const wallet = {
      publicKey: pubkey,
      signTransaction: async (tx: Transaction) => await (window.backpack!.solana!.signTransaction(tx)),
      signAllTransactions: async (txs: Transaction[]) => window.backpack!.solana!.signAllTransactions
        ? await window.backpack!.solana!.signAllTransactions!(txs)
        : Promise.all(txs.map(t => window.backpack!.solana!.signTransaction(t)))
    } as unknown as anchor.Wallet;
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    return new anchor.Program(IDL as any, PROGRAM_ID!, provider);
  }, [connection, pubkey]);

  /** Availability lookup */
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (PREVIEW_MODE) {
        if (normalized.length < 3 || !isValidNameCore(normalized)) { setLookup({ status: 'idle' }); return; }
        setLookup({ status: 'available' });
        return;
      }
      if (!HAS_CONFIG || !PROGRAM_ID) { setLookup({ status: 'error', message: 'Frontend not configured: set VITE_PROGRAM_ID and VITE_TREASURY in .env' }); return; }
      if (normalized.length < 3 || !isValidNameCore(normalized)) { setLookup({ status: 'idle' }); return; }

      setLookup({ status: 'checking' });
      try {
        const [pda] = await namePdaWithSeed(normalized);
        const info = await connection.getAccountInfo(pda, 'confirmed');
        if (!info) { if (!cancelled) setLookup({ status: 'available' }); return; }
        const decoded: any = ACCOUNTS_CODER.decode('NameRecord', info.data);
        const expiresAt = Number(decoded.expiresAt);
        const ownerPk: PublicKey = decoded.owner;
        const resolverPk: PublicKey = decoded.resolver;
        const initialized: boolean = decoded.initialized;
        if (!initialized) { if (!cancelled) setLookup({ status: 'available' }); return; }
        const isYours = !!pubkey && pubkey.equals(ownerPk);
        const now = Math.floor(Date.now() / 1000);
        if (now <= expiresAt) { if (!cancelled) setLookup({ status: 'taken', owner: ownerPk.toBase58(), resolver: resolverPk.toBase58(), expiresAt, isYours }); return; }
        if (now <= expiresAt + GRACE_SECS) { if (!cancelled) setLookup({ status: 'grace', owner: ownerPk.toBase58(), resolver: resolverPk.toBase58(), expiresAt, graceEndsAt: expiresAt + GRACE_SECS, isYours }); return; }
        if (!cancelled) setLookup({ status: 'expired', owner: ownerPk.toBase58(), resolver: resolverPk.toBase58(), expiresAt });
      } catch (e: any) {
        if (!cancelled) setLookup({ status: 'error', message: e?.message || String(e) });
      }
    };
    const t = setTimeout(run, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [normalized, pubkey, connection]);

  /** Helpers */
// --- create or get PAYER ATA (payer ATA may be created automatically) ---
const createOrGetAtaIx = async (owner: PublicKey) => {
  const ata = await getAssociatedTokenAddress(
    CARV_MINT,
    owner,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const info = await connection.getAccountInfo(ata, 'confirmed');
  if (!info) {
    return {
      ata,
      ix: createAssociatedTokenAccountInstruction(
        pubkey!,            // payer of ATA creation
        ata,                // ATA address
        owner,              // ATA owner
        CARV_MINT,          // mint
        tokenProgramId,     // TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
    };
  }
  return { ata, ix: null };
};

// --- REQUIRE the treasury’s CARV ATA to already exist (no creation) ---
async function requireTreasuryAtaExists(
  connection: Connection,
  mint: PublicKey,              // CARV mint
  treasury: PublicKey,          // your treasury wallet pubkey
  tokenProgramId: PublicKey,    // TOKEN_PROGRAM_ID (classic SPL) or TOKEN_2022_PROGRAM_ID
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(
    mint,
    treasury,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const info = await connection.getAccountInfo(ata, 'confirmed');
  if (!info) {
    throw new Error(
      `Treasury CARV ATA is missing (${ata.toBase58()}). ` +
      `Create it once on the treasury wallet.`
    );
  }
  // Optional sanity checks:
  const acct = await getAccount(connection, ata, 'confirmed', tokenProgramId);
  if (!acct.owner.equals(treasury)) throw new Error('Treasury ATA owner mismatch');
  if (!acct.mint.equals(mint)) throw new Error('Treasury ATA mint mismatch');
  console.log('[CNS] Using existing Treasury ATA:', ata.toBase58());
  return ata;
}

// --- PDA with SHA-256(lowercase(name)) seed ---
const namePdaWithSeed = async (nameLower: string): Promise<[PublicKey, number]> => {
  const seed = await nameSeed32(nameLower); // 32-byte SHA-256
  return PublicKey.findProgramAddressSync([bytes('cns'), seed], PROGRAM_ID!);
};

// Keep this:
const register = async () => { if (!pubkey) return; await registerForName(normalized, years); };

// --- FULL registerForName using sha256 seed and existing treasury ATA ---
const registerForName = async (targetName: string, yrs: number) => {
  try {
    setBusy(true); setMessage(null); setTxSig(null);
    if (!HAS_CONFIG || !PROGRAM_ID || !TREASURY_PUBKEY) {
      throw new Error('Frontend not configured: set VITE_PROGRAM_ID and VITE_TREASURY in .env');
    }
    if (!pubkey) throw new Error('Connect Backpack first.');

    // Enforce 3–64 and lowercase charset
    if (!/^[a-z0-9-]{3,64}$/.test(targetName)) {
      throw new Error('Invalid name. Use 3–64 chars: a–z, 0–9, "-"');
    }

    // Payer ATA: create if missing
    const payerAtaRes = await createOrGetAtaIx(pubkey);

    // Treasury ATA: must already exist
    const treasuryAta = await requireTreasuryAtaExists(
      connection,
      CARV_MINT,
      TREASURY_PUBKEY!,
      tokenProgramId
    );

    // Derive PDA using sha256(lowercase(name))
    const lower = targetName.toLowerCase();
    const seed = await nameSeed32(lower); // Uint8Array(32)
    const [nameRecord] = await namePdaWithSeed(lower);

    // Build anchor ix (note we pass the 32-byte seed as arg)
    const ix = await program!.methods
      .register(lower, yrs, Array.from(seed) as number[])
      .accounts({
        payer: pubkey,
        nameRecord,
        treasury: TREASURY_PUBKEY!,
        payerAta: payerAtaRes.ata,
        treasuryAta,                 // existing ATA
        carvMint: CARV_MINT,
        tokenProgram: tokenProgramId,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });

    // IMPORTANT: do NOT add any treasury ATA creation ix
    const tx = new Transaction().add(
      cu,
      ...(payerAtaRes.ix ? [payerAtaRes.ix] : []),
      ix
    );

    const sig = await sendTx(tx);
    setTxSig(sig);
    setMessage(`Success! ${lower}.carv ${lookup.status === 'taken' ? 'extended' : 'registered'}.`);
    await refreshBalances();
    await refreshMyNames();
  } catch (e: any) {
    setMessage(e.message ?? String(e));
  } finally {
    setBusy(false);
  }
};

  const refreshMyNames = useCallback(async () => {
    if (!pubkey) { setMyNames(null); return; }
    if (!HAS_CONFIG || !PROGRAM_ID) { setPortfolioError('Frontend not configured: set VITE_PROGRAM_ID and VITE_TREASURY in .env'); setMyNames(null); return; }
    setLoadingMyNames(true); setPortfolioError(null);
    try {
      const disc = await accountDiscriminator('NameRecord');
      const accounts = await connection.getProgramAccounts(PROGRAM_ID!, {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
      });

      const [revPk] = reversePda(pubkey);
      const revInfo: any = await connection.getAccountInfo(revPk, 'confirmed');
      let primaryName: string | null = null;
      if (revInfo) {
        try { const rev: any = ACCOUNTS_CODER.decode('ReverseRecord', revInfo.data); primaryName = String(rev.name); } catch {}
      }

      const now = Math.floor(Date.now() / 1000);
      const mine: MyName[] = [];
      for (const acc of accounts) {
        try {
          const decoded: any = ACCOUNTS_CODER.decode('NameRecord', acc.account.data as any);
          if (!decoded.initialized) continue;
          const ownerPk: PublicKey = decoded.owner;
          if (!pubkey.equals(ownerPk)) continue;
          const nm: string = String(decoded.name);
          const resolverPk: PublicKey = decoded.resolver;
          const expiresAt = Number(decoded.expiresAt);
          let status: MyName['status'] = 'expired';
          if (now <= expiresAt) status = 'active';
          else if (now <= expiresAt + GRACE_SECS) status = 'grace';
          const isPrimary = primaryName === nm;
          mine.push({ pda: acc.pubkey, name: nm, resolver: resolverPk.toBase58(), expiresAt, status, isPrimary });
        } catch {}
      }
      mine.sort((a, b) => a.expiresAt - b.expiresAt);
      setMyNames(mine);
    } catch (e: any) { setPortfolioError(e?.message ?? String(e)); setMyNames(null); }
    finally { setLoadingMyNames(false); }
  }, [connection, pubkey]);
  useEffect(() => { refreshMyNames().catch(() => {}); }, [refreshMyNames]);

  const transferName = async (row: MyName) => {
    if (!pubkey || !program) return;
    const input = window.prompt(`Transfer ${row.name}.carv to (recipient public key):`);
    if (!input) return; let newOwner: PublicKey; try { newOwner = new PublicKey(input.trim()); } catch { setMessage('Invalid public key'); return; }
    try {
      setBusy(true); setMessage(null); setTxSig(null);
      const sig = await program.methods
        .transfer_name(row.name, newOwner)
        .accounts({ owner: pubkey, nameRecord: row.pda })
        .rpc();
      setTxSig(sig); setMessage(`Transferred ${row.name}.carv to ${newOwner.toBase58().slice(0,4)}…${newOwner.toBase58().slice(-4)}`);
      await refreshMyNames();
    } catch (e: any) { setMessage(e.message ?? String(e)); } finally { setBusy(false); }
  };

  const setResolver = async (row: MyName) => {
    if (!pubkey || !program) return;
    const input = window.prompt(`Set resolver for ${row.name}.carv (public key):`, row.resolver);
    if (!input) return; let newResolver: PublicKey; try { newResolver = new PublicKey(input.trim()); } catch { setMessage('Invalid public key'); return; }
    try {
      setBusy(true); setMessage(null); setTxSig(null);
      const sig = await program.methods
        .set_resolver(row.name, newResolver)
        .accounts({ owner: pubkey, nameRecord: row.pda })
        .rpc();
      setTxSig(sig); setMessage(`Resolver updated for ${row.name}.carv`);
      await refreshMyNames();
    } catch (e: any) { setMessage(e.message ?? String(e)); } finally { setBusy(false); }
  };

  const setPrimary = async (row: MyName) => {
    if (!pubkey || !program) return;
    try {
      setBusy(true); setMessage(null); setTxSig(null);
      const [revPk] = reversePda(pubkey);
      const sig = await program.methods
        .set_primary(row.name)
        .accounts({ owner: pubkey, nameRecord: row.pda, reverseRecord: revPk, systemProgram: SystemProgram.programId })
        .rpc();
      setTxSig(sig); setMessage(`Primary name set to ${row.name}.carv`);
      await refreshMyNames();
    } catch (e: any) { setMessage(e.message ?? String(e)); } finally { setBusy(false); }
  };

  /** UI helpers */
  const solDisplay = solBalance == null ? '—' : solBalance.toLocaleString(undefined, { maximumFractionDigits: 6 });
  const carvDisplay = carvBalance == null ? '—' : carvBalance.toLocaleString(undefined, { maximumFractionDigits: 4 });

  const lockedByOthers =
    (lookup.status === 'taken' && !(lookup as any).isYours) ||
    (lookup.status === 'grace' && !(lookup as any).isYours);

  const registerDisabled =
    PREVIEW_MODE || !HAS_CONFIG || !pubkey || !isValidName(name) ||
    years < 1 || years > 10 || busy || decimals === null || lockedByOthers;

  const buttonLabel = (() => {
    if (!pubkey) return 'Connect Wallet First';
    if (busy) return 'Processing…';
    if (!fullLabel) return 'Register name';
    if (lookup.status === 'taken' && (lookup as any).isYours) return `Extend ${fullLabel}`;
    if (lookup.status === 'grace' && (lookup as any).isYours) return `Renew ${fullLabel}`;
    return `Register ${fullLabel}`;
  })();

  const [now, setNow] = useState<number>(Math.floor(Date.now() / 1000));
  useEffect(() => { const id = setInterval(() => setNow(Math.floor(Date.now()/1000)), 1000); return () => clearInterval(id); }, []);
  const graceCountdown = (() => {
    if (lookup.status !== 'grace') return null;
    const remaining = Math.max(0, (lookup as any).graceEndsAt - now);
    const d = Math.floor(remaining / 86400);
    const h = Math.floor((remaining % 86400) / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    return `${d}d ${h}h ${m}m ${s}s remaining`;
  })();

  // per-row renew state
  const [renewYears, setRenewYears] = useState<Record<string, number>>({});
  const getRenewYears = (n: string) => renewYears[n] ?? 1;
  const incRenew = (n: string, delta: number) => setRenewYears(prev => ({ ...prev, [n]: Math.max(1, Math.min(10, (prev[n] ?? 1) + delta)) }));

  /** ===== Header (full-width; balances only on /register) ===== */
  const Header = (
    <header
      className="app-header"
      style={{
        width: '100%',
        boxSizing: 'border-box',
        padding: '16px 28px',
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        alignItems: 'center',
        marginBottom: 12,
      }}
    >
      <div className="header-left brand" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <img src="/brand.svg" alt="CARV Name Service" className="brand-logo" style={{ height: 32, borderRadius: 8 }} />
        <div>
          <div className="title">CARV Name Service</div>
          <div className="subtitle">Decentralized Naming System on the CARV SVM Chain</div>
        </div>
      </div>

      <div className="header-right" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          className="btn btn-ghost"
          aria-label="Toggle theme"
          title={mode === 'dark' ? 'Switch to light' : 'Switch to dark'}
          onClick={() => setMode(m => (m === 'dark' ? 'light' : 'dark'))}
          style={{ width: 40, height: 40, borderRadius: 10 }}
        >
          {mode === 'dark' ? '🌙' : '☀️'}
        </button>

        {onRegistrarPage && pubkey && (
          <div
            className="wallet-pill"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderRadius: 999,
              border: '1px solid var(--border)',
              background: 'var(--panel)',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#43d182', boxShadow: '0 0 12px rgba(67,209,130,.75)' }} />
            <span className="pill">◎ {solDisplay} tSOL</span>
            <span className="pill">CARV {carvDisplay}</span>
          </div>
        )}

        <WalletMenu
          pubkey={pubkey}
          connect={connect}
          disconnect={disconnect}
          setMessage={setMessage}
          onViewNames={() => {
            navigate('/register');
            setTimeout(() => {
              const el = document.getElementById('my-names');
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
          }}
        />
      </div>
    </header>
  );

  /** ===== Landing (/) ===== */
  const Landing = (
    <>
      {Header}
      <div className="container">
        <section style={{ textAlign: 'center', margin: '48px 0 24px' }}>
          <h1 style={{ fontSize: 48, fontWeight: 800, margin: 0 }}>
            Your <span style={{ color: '#56ccf2' }}>Web3 Identity</span>
          </h1>
          <p className="subtitle" style={{ marginTop: 12, fontSize: 18 }}>
            Register a readable <b>.carv</b> domain name that resolves to your wallet on the CARV SVM Chain.
          </p>
        </section>

        <div className="card neon" style={{ margin: '0 auto', maxWidth: 880 }}>
          <h2 style={{ textAlign: 'center', marginTop: 0 }}>Get Started</h2>
          <p className="subtitle" style={{ textAlign: 'center', marginTop: -4 }} />

          <div style={{ marginTop: 24, display: 'grid', gap: 16 }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
              <div className="pill" style={{ width: 36, textAlign: 'center' }}>1</div>
              <div>
                <div style={{ fontWeight: 600 }}>Connect Your Wallet</div>
                <div className="subtitle">Sign in to access the naming service</div>
              </div>
            </div>

            <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
              <div className="pill" style={{ width: 36, textAlign: 'center' }}>2</div>
              <div>
                <div style={{ fontWeight: 600 }}>Search for Domains</div>
                <div className="subtitle">Find your perfect <b>.carv</b> domain name</div>
              </div>
            </div>

            <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
              <div className="pill" style={{ width: 36, textAlign: 'center' }}>3</div>
              <div>
                <div style={{ fontWeight: 600 }}>Register &amp; Manage</div>
                <div className="subtitle">Payments in CARV • Fees in testnet SOL</div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 28, textAlign: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={() => navigate('/register')}
              disabled={!pubkey}
              title={!pubkey ? 'Connect wallet to continue' : 'Open Registrar'}
              style={{ minWidth: 320, opacity: !pubkey ? 0.6 : 1, cursor: !pubkey ? 'not-allowed' : 'pointer' }}
            >
              Open Registrar
            </button>
            {!pubkey && (
              <div className="subtitle" style={{ marginTop: 8 }}>
                Connect your wallet to open the registrar.
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );

  /** ===== Registrar (/register) ===== */
  const Registrar = (
    <>
      {Header}
      <div className="container">
        <div className="row" style={{ marginTop: 8, marginBottom: 8 }}>
          <BackButton onClick={() => navigate('/')} />
        </div>
        {/* Hero */}
        <div className="card neon" style={{ marginTop: 16 }}>
          <div className="h1">Claim your <span className="accent">.carv</span> name</div>
        </div>

        {/* Registration */}
        <div className="card neon" style={{ marginTop: 16 }}>
          {/* Name field */}
          <div className="input-group" style={{ flex: 1 }}>
            <input
              placeholder="yourname"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              maxLength={64}
            />
            <span className="suffix-badge">.carv</span>
          </div>

          {/* Years stepper */}
          <div className="row stack-under">
            <div className="stepper">
              <button aria-label="Decrease years" onClick={() => setYears(Math.max(1, years - 1))}>−</button>
              <div className="pill">{years} year{years > 1 ? 's' : ''}</div>
              <button aria-label="Increase years" onClick={() => setYears(Math.min(10, years + 1))}>+</button>
            </div>

            {/* Total price */}
            <div className="total-inline">
              <b>Total:</b> {totalCarv} CARV
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
            <div className="subtitle">
              {normalized.length < 3
                ? 'Minimum 3 characters.'
                : <>Price: <b>{perYear}</b> CARV / year</>}
            </div>
            <div style={{ visibility: 'hidden' }}>spacer</div>
          </div>

          {/* Availability */}
          <div className="rule" />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700 }}>Availability</div>
            <div className="subtitle">Status updates as you type</div>
          </div>

          <div style={{ marginTop: 8 }}>
            {normalized.length < 3 || !isValidNameCore(normalized) ? (
              <div className="subtitle">Enter 3–64 characters (a–z, 0–9, “-”).</div>
            ) : lookup.status === 'checking' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="loader" />
                <div className="subtitle">Checking availability…</div>
              </div>
            ) : lookup.status === 'available' ? (
              <div>
                <span className="pill" style={{ borderColor: 'rgba(67,209,130,.35)', background: 'rgba(67,209,130,.14)' }}>
                  Available
                </span>
              </div>
            ) : lookup.status === 'grace' ? (
              <div>
                <span className="pill" style={{ background: 'rgba(255,221,170,.25)', borderColor: 'rgba(255,221,170,.45)' }}>
                  In 7-day grace (owner-only)
                </span>
                <div className="subtitle" style={{ marginTop: 6 }}>
                  Owner: {(lookup as any).owner.slice(0, 4)}…{(lookup as any).owner.slice(-4)} • Resolver: {(lookup as any).resolver.slice(0, 4)}…{(lookup as any).resolver.slice(-4)}
                </div>
                <div style={{ marginTop: 6 }}><b>Warning:</b> {graceCountdown}</div>
                <div style={{ marginTop: 6 }}><b>Note:</b> Transfers are <u>disabled</u> during grace; the owner can only renew.</div>
              </div>
            ) : lookup.status === 'expired' ? (
              <div><span className="pill">Expired — re-registerable</span></div>
            ) : lookup.status === 'taken' ? (
              <div><span className="pill">{(lookup as any).isYours ? 'Taken — Yours' : 'Taken'}</span></div>
            ) : lookup.status === 'error' ? (
              <div style={{ color: '#ff6b6b' }}>Lookup error: {(lookup as any).message}</div>
            ) : null}
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              onClick={register}
              disabled={registerDisabled}
              title={!pubkey ? 'Connect Backpack to continue' : undefined}
            >
              {buttonLabel}
            </button>
          </div>

          {message && <div style={{ marginTop: 10 }}>{message}</div>}
          {txSig && (
            <div style={{ marginTop: 6 }}>
              View transaction: <a href={explorerTx(txSig)} target="_blank" rel="noreferrer">{txSig}</a>
            </div>
          )}
        </div>

        {/* Portfolio */}
        <div id="my-names" className="card neon" style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700 }}>My Names</div>
            <button className="btn btn-ghost" onClick={() => refreshMyNames()}>Refresh</button>
          </div>

          {!pubkey ? (
            <div className="subtitle" style={{ marginTop: 8 }}>Connect Backpack to view your names.</div>
          ) : loadingMyNames ? (
            <div style={{ marginTop: 8 }}>Loading…</div>
          ) : portfolioError ? (
            <div style={{ marginTop: 8, color: '#ff6b6b' }}>Error: {portfolioError}</div>
          ) : !myNames || myNames.length === 0 ? (
            <div className="subtitle" style={{ marginTop: 8 }}>No names yet.</div>
          ) : (
            <div style={{ marginTop: 10 }}>
              {myNames.map((row) => {
                const now = nowTs;
                const remaining = Math.max(0, (row.status === 'active' ? row.expiresAt : row.expiresAt + GRACE_SECS) - now);
                const fmt = (secs: number) => {
                  const d = Math.floor(secs / 86400);
                  const h = Math.floor((secs % 86400) / 3600);
                  const m = Math.floor((secs % 3600) / 60);
                  const s = secs % 60;
                  return `${d}d ${h}h ${m}m ${s}s`;
                };
                return (
                  <div key={row.pda.toBase58()} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1.4fr auto', gap: 10, alignItems: 'center', padding: '12px 0', borderTop: '1px solid var(--border)' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{row.name}.carv {row.isPrimary && <span className="pill" style={{ marginLeft: 6 }}>Primary</span>}</div>
                      <div className="subtitle">Resolver: {row.resolver.slice(0, 4)}…{row.resolver.slice(-4)}</div>
                    </div>
                    <div>
                      <div className="subtitle">Expires</div>
                      <div>{new Date(row.expiresAt * 1000).toUTCString()}</div>
                    </div>
                    <div>
                      <div className="subtitle">Status</div>
                      {row.status === 'active' && <div><span className="pill">Active</span> <span className="subtitle">{fmt(remaining)}</span></div>}
                      {row.status === 'grace' && <div><span className="pill" style={{ background: '#ffddaa' }}>In grace</span> <span className="subtitle">{fmt(remaining)} left</span></div>}
                      {row.status === 'expired' && <div><span className="pill">Expired</span></div>}
                    </div>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <div className="stepper">
                        <button onClick={() => incRenew(row.name, -1)}>−</button>
                        <div className="pill">{getRenewYears(row.name)}y</div>
                        <button onClick={() => incRenew(row.name, +1)}>+</button>
                      </div>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => registerForName(row.name, getRenewYears(row.name))}>
                        {row.status === 'active' ? 'Extend' : row.status === 'grace' ? 'Renew' : 'Re-register'}
                      </button>
                      <button className="btn btn-ghost" disabled={busy || row.status !== 'active'} onClick={() => transferName(row)}>Transfer</button>
                      <button className="btn btn-ghost" disabled={busy || row.isPrimary || row.status === 'expired'} onClick={() => setPrimary(row)}>Set primary</button>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => setResolver(row)}>Set resolver</button>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <a href={explorerAccount(row.pda)} target="_blank" rel="noreferrer">View</a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="subtitle" style={{ marginTop: 12 }}>
          • Allowed characters: <code>a–z</code>, <code>0–9</code>, <code>-</code> • 3–64 chars<br />
          • 7-day grace: owner can renew; after grace, anyone can re-register.<br />
          • All actions are on-chain; transactions appear in the explorer.
        </div>
      </div>
    </>
  );

  /** ===== Routes ===== */
  return (
    <Routes>
      <Route path="/" element={Landing} />
      <Route path="/register" element={Registrar} />
    </Routes>
  );
}
