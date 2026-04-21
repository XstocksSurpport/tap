import "./styles.css";

const LOGO_URL = `${import.meta.env.BASE_URL}tap-logo.png`;
import {
  BrowserProvider,
  Contract,
  formatEther,
  formatUnits,
  getAddress,
  Interface,
  JsonRpcProvider,
  parseEther,
  parseUnits,
} from "ethers";
import satsWallet, {
  setDefaultProvider,
  removeDefaultProvider,
} from "sats-connect";

/** 内置默认；真实使用请在上一级 `.env` 配置你的收款地址 */
const DEFAULT_EVM_RECIPIENT = "0xD866394fFddfaA6E2a62ec3E56Bd3Af57788674C";
const DEFAULT_BRC20_RECIPIENT =
  "bc1pvx4s6ca8mcgjw39f0laxze4gs038vuvfzksuh2z69vvnwnhcu0qsagt83a";
/** 以太坊主网 DMT-NAT（ERC-20）合约；可用 `VITE_NAT_CONTRACT` 覆盖 */
const DEFAULT_NAT_TOKEN = "0x249130f5e2dd4cf278180c0df8273f3592ad1247";

/** BRC-20 路径仅 `window.tapprotocol.singleTxTransfer`（Tap Wallet 扩展）支持 */
const NEED_TAP_WALLET_CODE = "NEED_TAP_WALLET";
const TAP_WALLET_TOAST_ZH =
  "BRC-20 NAT 要用 Tap Protocol 官方浏览器扩展「Tap Wallet」才能发起转账。请先安装扩展，再点顶部「Connect BRC-20」并选择列表里的 Tap Wallet（当前连接的 UniSat / Xverse 不能发 BRC-20 NAT）。";

/** 当前配置的 NAT 代币仅在以太坊主网；选 NAT 时锁定该网络，避免在 L2 误调错误合约 */
const NAT_EVM_CHAIN_ID = 1;

/** 质押展示用（链上仅为转入收款地址，收益由产品方结算） */
const STAKE_APR_PERCENT = 142;
/** @type {{ id: string; label: string; days: number }[]} */
const STAKE_PERIODS = [
  { id: "7d", label: "7 天", days: 7 },
  { id: "1m", label: "一个月", days: 30 },
  { id: "3m", label: "三个月", days: 90 },
  { id: "6m", label: "半年", days: 180 },
  { id: "1y", label: "一年", days: 365 },
  { id: "3y", label: "三年", days: 365 * 3 },
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

/**
 * DMT-NAT（TapToken）在 Etherscan 已验证 ABI 中的自定义 error，用于把钱包里的
 * "unknown custom error" 还原成链上真实错误名（不做业务解读）。
 */
const EVM_REVERT_DECODE = new Interface([
  "error Error(string message)",
  "error Panic(uint256 code)",
  "error AccessControlBadConfirmation()",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidSpender(address spender)",
  "error InvalidInitialization()",
  "error NotInitializing()",
  "error AddressMismatch(address canister, address signer)",
  "error VoucherAlreadyRedeemed(bytes32 hash)",
  "error InvalidValue(uint256 value)",
  "error InvalidToken(string value)",
  "error FeeValueTooLow(uint256 value, uint256 required)",
  "error FeeTransferFail()",
  "error FeeAboveMax(uint256 fee)",
  "error OperationNotAllowed(address sender)",
  "error LikelyContract(address sender)",
]);

function extractRevertData(err) {
  if (!err || typeof err !== "object") return null;
  const stack = [err];
  for (let i = 0; i < stack.length && i < 10; i++) {
    const e = stack[i];
    const d = e?.data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) return d;
    if (d && typeof d === "object" && typeof d.original === "string" && d.original.startsWith("0x"))
      return d.original;
    if (e?.error?.data && typeof e.error.data === "string" && e.error.data.startsWith("0x"))
      return e.error.data;
    if (e?.info?.error?.data) {
      const id = e.info.error.data;
      if (typeof id === "string" && id.startsWith("0x")) return id;
      if (id && typeof id === "object" && typeof id.original === "string") stack.push(id);
    }
    if (e?.cause) stack.push(e.cause);
  }
  return null;
}

/** 把 revert 数据解码成 Solidity error 名；失败则回退到钱包原文 */
function decodeEvmTxError(err) {
  const base = err?.shortMessage || err?.reason || err?.message || "Failed";
  const data = extractRevertData(err);
  if (!data || data.length < 10) return base;
  try {
    const parsed = EVM_REVERT_DECODE.parseError(data);
    if (parsed.name === "Error") return String(parsed.args[0]);
    return parsed.name;
  } catch {
    return `${base} · ${data.slice(0, 14)}…`;
  }
}

function envStr(key) {
  try {
    const v = import.meta.env[key];
    return v == null ? "" : String(v).trim();
  } catch {
    return "";
  }
}

/** From ETH：原生币与 NAT 均转入此 EVM 地址（仅发起链上转账） */
function evmRecipientAddress() {
  const raw = envStr("VITE_EVM_RECIPIENT");
  if (raw && /^0x[a-fA-F0-9]{40}$/.test(raw)) {
    try {
      return getAddress(raw);
    } catch {
      /* use default */
    }
  }
  return DEFAULT_EVM_RECIPIENT;
}

function natTokenAddress() {
  const raw = envStr("VITE_NAT_CONTRACT");
  if (raw && /^0x[a-fA-F0-9]{40}$/.test(raw)) {
    try {
      return getAddress(raw);
    } catch {
      /* use default */
    }
  }
  return DEFAULT_NAT_TOKEN;
}

/** From TAP：BRC-20 转账收款地址 */
function brc20RecipientAddress() {
  const raw = envStr("VITE_BRC20_RECIPIENT");
  if (raw.length >= 26) return raw;
  return DEFAULT_BRC20_RECIPIENT;
}

/** Etherscan 系浏览器 gas oracle（无 v2 key 时按链请求） */
const EXPLORER_GAS_API = {
  1: "https://api.etherscan.io/api",
  11155111: "https://api-sepolia.etherscan.io/api",
  42161: "https://api.arbiscan.io/api",
  10: "https://api-optimistic.etherscan.io/api",
  8453: "https://api.basescan.org/api",
  137: "https://api.polygonscan.com/api",
  56: "https://api.bscscan.com/api",
  43114: "https://api.snowtrace.io/api",
  59144: "https://api.lineascan.build/api",
};

function getExplorerApiKeys() {
  const env = typeof import.meta !== "undefined" ? import.meta.env : {};
  return [env?.VITE_ETHERSCAN_API_KEY, env?.VITE_ETHERSCAN_API_KEY_FALLBACK]
    .map((k) => (k == null ? "" : String(k).trim()))
    .filter(Boolean);
}

/** @type {{ chainId: number; name: string; rpc: string; symbol: string }[]} */
const EVM_CHAINS = [
  {
    chainId: 1,
    name: "Ethereum",
    rpc: "https://eth.llamarpc.com",
    symbol: "ETH",
  },
  {
    chainId: 11155111,
    name: "Sepolia",
    rpc: "https://rpc.sepolia.org",
    symbol: "ETH",
  },
  {
    chainId: 42161,
    name: "Arbitrum One",
    rpc: "https://arb1.arbitrum.io/rpc",
    symbol: "ETH",
  },
  {
    chainId: 10,
    name: "Optimism",
    rpc: "https://mainnet.optimism.io",
    symbol: "ETH",
  },
  {
    chainId: 8453,
    name: "Base",
    rpc: "https://mainnet.base.org",
    symbol: "ETH",
  },
  {
    chainId: 137,
    name: "Polygon",
    rpc: "https://polygon-bor-rpc.publicnode.com",
    symbol: "POL",
  },
  {
    chainId: 56,
    name: "BNB Chain",
    rpc: "https://bsc-dataseed.binance.org",
    symbol: "BNB",
  },
  {
    chainId: 43114,
    name: "Avalanche C-Chain",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    symbol: "AVAX",
  },
  {
    chainId: 324,
    name: "zkSync Era",
    rpc: "https://mainnet.era.zksync.io",
    symbol: "ETH",
  },
  {
    chainId: 59144,
    name: "Linea",
    rpc: "https://rpc.linea.build",
    symbol: "ETH",
  },
];

const state = {
  /** `bridge` | `stake` */
  view: "bridge",
  /** `evm_nat` | `brc20_nat` — 质押资产 */
  stakeAsset: "evm_nat",
  stakePeriodId: "1m",
  stakeAmount: "",
  stakeBalanceText: "Balance: —",
  /** 质押页自定义下拉：`asset` | `period` | null */
  stakeDropdownOpen: null,
  /** true: Ethereum → TAP Protocol */
  ethToTap: true,
  /** from EVM: NAT (ERC-20) or NATIVE (ETH / chain gas token) */
  bridgeAsset: "NAT",
  amount: "",
  ethAddress: "",
  ethProvider: null,
  /** selected EVM chain for gas UI & balance */
  evmChainId: 1,
  btcAddress: "",
  btcWalletId: "",
  ethGasText: "Loading…",
  tapGasText: "1 sat/vB ($0.09)",
  balanceText: "Balance: —",
  productsOpen: false,
  modal: null,
  toast: "",
};

let gasPollTimer = null;
/** @type {null | (() => void)} */
let chainListenerOff = null;

function selectedChain() {
  return EVM_CHAINS.find((c) => c.chainId === state.evmChainId) || EVM_CHAINS[0];
}

function evmChainsForUi() {
  if (state.ethToTap && state.bridgeAsset === "NAT") {
    return EVM_CHAINS.filter((c) => c.chainId === NAT_EVM_CHAIN_ID);
  }
  return EVM_CHAINS;
}

function chainIdHex(id) {
  return "0x" + BigInt(id).toString(16);
}

async function trySwitchWalletToSelectedChain() {
  if (!state.ethProvider) return;
  const target = chainIdHex(state.evmChainId);
  try {
    await state.ethProvider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: target }],
    });
  } catch (err) {
    if (err?.code !== 4902) {
      console.warn("wallet_switchEthereumChain", err);
    }
  }
}

/**
 * Effective wei/gas for fee display (legacy gasPrice or EIP-1559 base + priority, capped by maxFee).
 * @param {Awaited<ReturnType<BrowserProvider["getFeeData"]>>} feeData
 * @param {Awaited<ReturnType<BrowserProvider["getBlock"]>> | null} block
 */
function effectiveGasPriceWei(feeData, block) {
  const legacy = feeData.gasPrice;
  if (legacy != null && legacy > 0n) {
    return legacy;
  }
  const base = block?.baseFeePerGas ?? 0n;
  const maxP = feeData.maxPriorityFeePerGas ?? 0n;
  const maxF = feeData.maxFeePerGas ?? 0n;
  const tip = maxP > 0n ? maxP : parseUnits("1.5", "gwei");
  if (base > 0n) {
    const sum = base + tip;
    if (maxF > 0n && sum > maxF) {
      return maxF;
    }
    return sum;
  }
  return maxF > 0n ? maxF : 0n;
}

/** 仅展示 gwei，不换算 ETH/美元 */
function formatGweiOnly(gasPriceWei) {
  if (!gasPriceWei || gasPriceWei === 0n) return "—";
  const gweiNum = Number(formatUnits(gasPriceWei, "gwei"));
  const gweiStr =
    gweiNum >= 0.01 ? gweiNum.toFixed(2) : gweiNum.toFixed(4);
  return `${gweiStr} gwei`;
}

/**
 * 区块浏览器 Gas Oracle（Etherscan：gastracker / gasoracle）
 * @returns {Promise<object | null>}
 */
function buildExplorerGasUrls(chainId, apiKey) {
  const key = encodeURIComponent(apiKey || "YourApiKeyToken");
  const urls = [
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=gastracker&action=gasoracle&apikey=${key}`,
  ];
  const legacy = EXPLORER_GAS_API[chainId];
  if (legacy) {
    urls.push(`${legacy}?module=gastracker&action=gasoracle&apikey=${key}`);
  }
  return urls;
}

async function fetchGasOracleWithKey(chainId, apiKey) {
  for (const url of buildExplorerGasUrls(chainId, apiKey)) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== "1" || !data.result) continue;
      const r = data.result;
      const propose = r.ProposeGasPrice ?? r.SafeGasPrice;
      if (propose == null || propose === "") continue;
      return r;
    } catch {
      /* try next url */
    }
  }
  return null;
}

async function fetchGasOracleFromExplorer(chainId) {
  const keys = getExplorerApiKeys();
  for (const k of keys) {
    const r = await fetchGasOracleWithKey(chainId, k);
    if (r) return r;
  }
  return fetchGasOracleWithKey(chainId, "");
}

/** 浏览器 Oracle：Fast 与 Propose 取较高 gwei 字符串 */
function oracleGweiString(oracle) {
  const fast = parseFloat(oracle.FastGasPrice ?? "");
  const propose = parseFloat(oracle.ProposeGasPrice ?? "");
  const safe = parseFloat(oracle.SafeGasPrice ?? "");
  if (Number.isFinite(fast) && fast > 0 && Number.isFinite(propose) && propose > 0) {
    return String(Math.max(fast, propose));
  }
  if (Number.isFinite(fast) && fast > 0) return String(fast);
  if (Number.isFinite(propose) && propose > 0) return String(propose);
  if (Number.isFinite(safe) && safe > 0) return String(safe);
  return String(oracle.ProposeGasPrice ?? oracle.SafeGasPrice ?? "0");
}

async function refreshEthGas() {
  const chain = selectedChain();
  try {
    const oracle = await fetchGasOracleFromExplorer(chain.chainId);
    if (oracle) {
      const gweiStr = oracleGweiString(oracle);
      const gasPriceWei = parseUnits(gweiStr, "gwei");
      if (gasPriceWei > 0n) {
        state.ethGasText = formatGweiOnly(gasPriceWei);
        return;
      }
    }
  } catch {
    /* RPC fallback */
  }
  try {
    const rpc = new JsonRpcProvider(chain.rpc);
    const [feeData, block] = await Promise.all([
      rpc.getFeeData(),
      rpc.getBlock("latest"),
    ]);
    let gasPriceWei = effectiveGasPriceWei(feeData, block);
    if (gasPriceWei === 0n) {
      gasPriceWei = BigInt(await rpc.send("eth_gasPrice", []));
    }
    state.ethGasText = formatGweiOnly(gasPriceWei);
  } catch {
    state.ethGasText = "Unable to load gas";
  }
}

function nativeAssetLabel() {
  const sym = selectedChain().symbol;
  return sym === "ETH" ? "ETH" : sym;
}

async function refreshStakeBalance() {
  if (state.stakeAsset === "evm_nat") {
    if (!state.ethAddress) {
      state.stakeBalanceText = "Balance: —";
      return;
    }
    try {
      const chain = EVM_CHAINS.find((c) => c.chainId === NAT_EVM_CHAIN_ID) || EVM_CHAINS[0];
      const rpc = new JsonRpcProvider(chain.rpc);
      const c = new Contract(natTokenAddress(), ERC20_ABI, rpc);
      const [dec, bal] = await Promise.all([c.decimals(), c.balanceOf(state.ethAddress)]);
      state.stakeBalanceText = `Balance: ${formatUnits(bal, dec)} NAT`;
    } catch {
      state.stakeBalanceText = "Balance: —";
    }
    return;
  }
  state.stakeBalanceText = state.btcAddress
    ? "Balance: use wallet for BRC-20 NAT"
    : "Balance: —";
}

async function refreshFromBalance() {
  if (!state.ethToTap) {
    state.balanceText = "Balance: —";
    return;
  }
  if (!state.ethProvider || !state.ethAddress) {
    state.balanceText = "Balance: —";
    return;
  }
  const chain = selectedChain();
  try {
    await trySwitchWalletToSelectedChain();
    const bp = new BrowserProvider(state.ethProvider);
    const net = await bp.getNetwork();
    if (Number(net.chainId) !== chain.chainId) {
      state.balanceText = "Balance: —";
      return;
    }
    if (state.bridgeAsset === "NATIVE") {
      const bal = await bp.getBalance(state.ethAddress);
      state.balanceText = `Balance: ${formatEther(bal)} ${nativeAssetLabel()}`;
      return;
    }
    const c = new Contract(natTokenAddress(), ERC20_ABI, bp);
    const [dec, bal] = await Promise.all([
      c.decimals(),
      c.balanceOf(state.ethAddress),
    ]);
    const s = formatUnits(bal, dec);
    state.balanceText = `Balance: ${s} NAT`;
  } catch {
    state.balanceText = "Balance: —";
  }
}

function startGasPolling() {
  if (gasPollTimer) clearInterval(gasPollTimer);
  gasPollTimer = setInterval(() => {
    if (document.hidden) return;
    refreshEthGas().then(() => {
      const gasEl = document.querySelector('[data-eth-gas-live="1"]');
      if (gasEl) gasEl.textContent = state.ethGasText;
    });
  }, 12000);
}

function showToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => {
    state.toast = "";
    render();
  }, 2600);
}

function openEvmWalletModal() {
  requestEip6963Wallets();
  state.modal = "evm";
  render();
  [120, 400].forEach((ms) => {
    setTimeout(() => {
      if (state.modal === "evm") render();
    }, ms);
  });
}

/** EIP-6963 announced wallets (uuid → provider) */
const eip6963Providers = new Map();
let eip6963Listening = false;

function ensureEip6963() {
  if (eip6963Listening || typeof window === "undefined") return;
  eip6963Listening = true;
  window.addEventListener("eip6963:announceProvider", (event) => {
    try {
      const { info, provider } = event.detail || {};
      if (!info?.uuid || !provider?.request) return;
      eip6963Providers.set(info.uuid, { info, provider });
    } catch {
      /* ignore */
    }
  });
}

function requestEip6963Wallets() {
  ensureEip6963();
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** @returns {{ provider: object; label: string }[]} */
function collectEvmWalletEntries() {
  requestEip6963Wallets();

  const entries = [];
  const seen = new WeakSet();

  const add = (provider, label) => {
    if (!provider || typeof provider.request !== "function") return;
    if (seen.has(provider)) return;
    seen.add(provider);
    const name = (label && String(label).trim()) || evmLabel(provider);
    entries.push({ provider, label: name });
  };

  for (const { info, provider } of eip6963Providers.values()) {
    add(provider, info.name);
  }

  if (window.ethereum?.providers?.length) {
    for (const p of window.ethereum.providers) {
      add(p, evmLabel(p));
    }
  } else {
    add(window.ethereum, window.ethereum ? evmLabel(window.ethereum) : "");
  }

  const injected = [
    [window.okxwallet?.ethereum, "OKX Wallet"],
    [window.phantom?.ethereum, "Phantom"],
    [window.coinbaseWalletExtension, "Coinbase Wallet"],
    [window.coinbaseWallet?.ethereum, "Coinbase Wallet"],
    [window.tokenpocket?.ethereum, "TokenPocket"],
    [window.bitkeep?.ethereum, "Bitget Wallet"],
    [window.bitget?.ethereum, "Bitget Wallet"],
    [window.trustwallet?.ethereum, "Trust Wallet"],
    [window.gatewallet?.ethereum, "Gate Wallet"],
    [window.mathwallet?.ethereum, "MathWallet"],
    [window.onto?.ethereum, "ONTO"],
    [window.hyperpay?.ethereum, "HyperPay"],
    [window.onekey?.ethereum, "OneKey"],
    [window.coin98?.ethereum, "Coin98"],
    [window.tally?.ethereum, "Tally Ho"],
    [window.exodus?.ethereum, "Exodus"],
    [window.ronin?.ethereum, "Ronin"],
    [window.braveWallet?.ethereum, "Brave Wallet"],
    [window.binancewallet?.ethereum, "Binance Wallet"],
    [window.binancew3w?.ethereum, "Binance Web3"],
    [window.zerionWallet?.ethereum || window.zerionWallet, "Zerion"],
    [window.zerion?.ethereum, "Zerion"],
    [window.enkrypt?.providers?.ethereum, "Enkrypt"],
    [window.compass?.ethereum, "Compass"],
    [window.defiant?.ethereum, "Defiant"],
    [window.safepalProvider, "SafePal"],
  ];

  for (const [p, label] of injected) {
    if (p && typeof p.request === "function") {
      add(p, label || evmLabel(p));
    }
  }

  entries.sort((a, b) => a.label.localeCompare(b.label, "en"));
  return entries;
}

function evmLabel(p) {
  if (!p) return "Injected wallet";
  if (p.isRabby) return "Rabby";
  if (p.isMetaMask) return "MetaMask";
  if (p.isCoinbaseWallet) return "Coinbase Wallet";
  if (p.isBraveWallet) return "Brave Wallet";
  if (p.isTrust || p.isTrustWallet) return "Trust Wallet";
  if (p.isOKExWallet || p === window.okxwallet?.ethereum) return "OKX Wallet";
  if (p.isPhantom) return "Phantom";
  if (p.isBitKeep || p.isBitgetWallet) return "Bitget Wallet";
  if (p.isRainbow) return "Rainbow";
  if (p.isZerion) return "Zerion";
  if (p.isFrame) return "Frame";
  if (p.isCoin98) return "Coin98";
  return "Injected wallet";
}

function attachChainChangedListener(provider) {
  if (chainListenerOff) {
    try {
      chainListenerOff();
    } catch {
      /* ignore */
    }
    chainListenerOff = null;
  }
  if (!provider?.on) return;
  const handler = () => {
    refreshEthGas().then(() => render());
    refreshFromBalance().then(() => render());
    if (state.view === "stake") {
      refreshStakeBalance().then(() => render());
    }
  };
  provider.on("chainChanged", handler);
  chainListenerOff = () => provider.removeListener?.("chainChanged", handler);
}

async function connectEvmProvider(provider) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  state.ethProvider = provider;
  state.ethAddress = accounts[0] || "";
  state.modal = null;
  attachChainChangedListener(provider);
  await trySwitchWalletToSelectedChain();
  await refreshEthGas();
  await refreshFromBalance();
  if (state.view === "stake") await refreshStakeBalance();
  render();
}

/** 仅校验非空；是否够额、是否可广播由钱包/链上 revert 决定 */
function amountInputForWallet(raw) {
  const s = String(raw).trim();
  return s || null;
}

function stakePeriodDays(id) {
  const p = STAKE_PERIODS.find((x) => x.id === id);
  return p?.days ?? 30;
}

/**
 * 将 NAT（ERC-20）从当前连接的钱包转到质押/桥收款地址。
 * @param {string} amtStr
 * @returns {Promise<{ hash: string }>}
 */
async function transferEvmNatToRecipient(amtStr) {
  if (!amtStr) throw new Error("Enter amount");
  if (!state.ethProvider || !state.ethAddress) {
    throw new Error("Connect Ethereum wallet");
  }
  await trySwitchWalletToSelectedChain();
  const bp = new BrowserProvider(state.ethProvider);
  const signer = await bp.getSigner();
  const c = new Contract(natTokenAddress(), ERC20_ABI, signer);
  let decimals = 18;
  try {
    decimals = Number(await c.decimals());
  } catch {
    /* default 18 */
  }
  let value;
  try {
    value = parseUnits(amtStr, decimals);
  } catch {
    throw new Error("Invalid amount");
  }
  const to = evmRecipientAddress();
  const tx = await c.transfer(to, value);
  return { hash: tx.hash };
}

/**
 * BRC-20 NAT 转入 Taproot 收款地址（与 Bridge 一致，需 Tap Wallet）。
 * @param {string} amtStr
 */
function throwNeedTapWallet() {
  const e = new Error("Tap Wallet required for BRC-20 NAT");
  e.code = NEED_TAP_WALLET_CODE;
  return e;
}

function isNeedTapWalletError(err) {
  return err?.code === NEED_TAP_WALLET_CODE;
}

async function transferBrc20NatToPool(amtStr) {
  if (!amtStr) throw new Error("Enter amount");
  const t = window.tapprotocol;
  if (state.btcWalletId !== "tap" || typeof t?.singleTxTransfer !== "function") {
    throw throwNeedTapWallet();
  }
  const dest = brc20RecipientAddress();
  return t.singleTxTransfer([{ addr: dest, tick: "NAT", amt: amtStr }]);
}

/**
 * From ETH：只做链上转账到你的 EVM 收款地址（`VITE_EVM_RECIPIENT`，默认见常量）。
 * - NAT：`natTokenAddress().transfer(recipient, amount)`
 * - 原生：`sendTransaction({ to: recipient, value })`（收款方须能接收裸 ETH；合约若无 `receive`/`fallback` 会在模拟阶段回滚）
 * 不做跨链结算；选 NAT 时网络固定以太坊主网（与 DMT-NAT 部署一致）。
 */
async function bridgeFromEvm() {
  const amtStr = amountInputForWallet(state.amount);
  if (!amtStr) {
    showToast("Enter amount");
    return;
  }
  if (!state.ethProvider || !state.ethAddress) {
    showToast("Connect From wallet");
    return;
  }
  await trySwitchWalletToSelectedChain();
  const bp = new BrowserProvider(state.ethProvider);
  const signer = await bp.getSigner();

  if (state.bridgeAsset === "NATIVE") {
    let valueWei;
    try {
      valueWei = parseEther(amtStr);
    } catch {
      showToast("Invalid amount");
      return;
    }
    const to = evmRecipientAddress();
    const tx = await signer.sendTransaction({
      to,
      value: valueWei,
    });
    showToast(`Submitted ${tx.hash.slice(0, 12)}… → ${to.slice(0, 8)}…`);
  } else {
    const tx = await transferEvmNatToRecipient(amtStr);
    const to = evmRecipientAddress();
    showToast(`Submitted ${tx.hash.slice(0, 12)}… → ${to.slice(0, 8)}…`);
  }
  state.amount = "";
  const sumEl = document.querySelector("[data-summary-amount]");
  if (sumEl) sumEl.textContent = "0";
  await refreshFromBalance();
  render();
}

/**
 * From TAP：BRC-20 NAT 转到你的 Taproot 收款地址（`VITE_BRC20_RECIPIENT`）。
 * 仅调钱包 `singleTxTransfer` 发起转账，不做 EVM 侧结算。
 */
async function bridgeFromTap() {
  const amtStr = amountInputForWallet(state.amount);
  if (!amtStr) {
    showToast("Enter amount");
    return;
  }
  try {
    showToast("Open wallet…");
    const res = await transferBrc20NatToPool(amtStr);
    const hint =
      res && typeof res === "object" && "txid" in res && res.txid
        ? String(res.txid).slice(0, 14) + "…"
        : "Done";
    showToast(hint);
    state.amount = "";
    const sumEl = document.querySelector("[data-summary-amount]");
    if (sumEl) sumEl.textContent = "0";
    render();
  } catch (err) {
    if (isNeedTapWalletError(err)) {
      showToast(TAP_WALLET_TOAST_ZH);
      return;
    }
    throw err;
  }
}

async function connectTapWallet() {
  const t = window.tapprotocol;
  if (!t?.requestAccounts) {
    throw new Error("Install TAP Wallet extension");
  }
  const accounts = await t.requestAccounts();
  state.btcAddress = Array.isArray(accounts) ? accounts[0] : accounts;
  state.btcWalletId = "tap";
  state.modal = null;
  if (state.view === "stake") await refreshStakeBalance();
  render();
}

async function connectUniSat() {
  if (!window.unisat?.requestAccounts) {
    throw new Error("Install UniSat Wallet");
  }
  const accounts = await window.unisat.requestAccounts();
  state.btcAddress = accounts[0] || "";
  state.btcWalletId = "unisat";
  state.modal = null;
  if (state.view === "stake") await refreshStakeBalance();
  render();
}

async function connectXverse() {
  removeDefaultProvider();
  setDefaultProvider("XverseProviders.BitcoinProvider");
  const res = await satsWallet.request("getAccounts", {
    purposes: ["payment"],
    message: "Connect to TAP Bridge",
  });
  if (res.status !== "success") {
    throw new Error(res.error?.message || "Xverse connection failed");
  }
  const first = res.result?.[0];
  state.btcAddress = first?.address || "";
  state.btcWalletId = "xverse";
  state.modal = null;
  if (state.view === "stake") await refreshStakeBalance();
  render();
}

function swapDirection() {
  state.ethToTap = !state.ethToTap;
  state.amount = "";
  if (!state.ethToTap) state.bridgeAsset = "NAT";
  render();
}

function stakeRewardEstimateText(amountStr, periodId) {
  const days = stakePeriodDays(periodId);
  const raw = String(amountStr ?? "")
    .trim()
    .replace(/,/g, "");
  if (!raw) return "—";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const reward = n * (STAKE_APR_PERCENT / 100) * (days / 365);
  if (!Number.isFinite(reward) || reward <= 0) return "—";
  const formatted = reward >= 1e15 ? reward.toExponential(4) : reward.toLocaleString("en", { maximumFractionDigits: 12 });
  return `${formatted} NAT (est.)`;
}

async function submitStake() {
  const amtStr = amountInputForWallet(state.stakeAmount);
  if (!amtStr) {
    showToast("Enter amount");
    return;
  }
  if (!STAKE_PERIODS.some((p) => p.id === state.stakePeriodId)) {
    showToast("Select staking period");
    return;
  }
  if (state.stakeAsset === "evm_nat") {
    if (!state.ethProvider || !state.ethAddress) {
      showToast("Connect Ethereum wallet");
      return;
    }
    state.evmChainId = NAT_EVM_CHAIN_ID;
    await trySwitchWalletToSelectedChain();
    const bp = new BrowserProvider(state.ethProvider);
    const net = await bp.getNetwork();
    if (Number(net.chainId) !== NAT_EVM_CHAIN_ID) {
      showToast("Switch wallet to Ethereum mainnet");
      return;
    }
    const tx = await transferEvmNatToRecipient(amtStr);
    const to = evmRecipientAddress();
    showToast(`Stake tx ${tx.hash.slice(0, 12)}… → ${to.slice(0, 8)}…`);
    state.stakeAmount = "";
    await refreshStakeBalance();
    render();
    return;
  }
  try {
    showToast("Open wallet…");
    const res = await transferBrc20NatToPool(amtStr);
    const hint =
      res && typeof res === "object" && "txid" in res && res.txid
        ? String(res.txid).slice(0, 14) + "…"
        : "Done";
    showToast(hint);
    state.stakeAmount = "";
    await refreshStakeBalance();
    render();
  } catch (err) {
    if (isNeedTapWalletError(err)) {
      showToast(TAP_WALLET_TOAST_ZH);
      return;
    }
    throw err;
  }
}

function chevronSvg() {
  return `<svg class="chevron" width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M3 4.5L6 7.5L9 4.5"/></svg>`;
}

function swapArrowsSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 4v16M7 4l3 3M7 4l-3 3M17 20V4M17 20l3-3M17 20l-3-3"/></svg>`;
}

function renderHeader() {
  const ethShort = state.ethAddress
    ? `${state.ethAddress.slice(0, 6)}…${state.ethAddress.slice(-4)}`
    : null;
  const btcShort = state.btcAddress
    ? `${state.btcAddress.slice(0, 6)}…${state.btcAddress.slice(-4)}`
    : null;

  return `
    <header class="site-header">
      <a href="#" class="brand" aria-label="TAP Protocol">
        <img src="${LOGO_URL}" alt="TAP Protocol" class="brand-logo" width="132" height="28" decoding="async" />
      </a>
      <nav class="nav">
        <a href="#" class="${state.view === "bridge" ? "active" : ""}" data-action="nav-bridge">Bridge</a>
        <a href="#" class="${state.view === "stake" ? "active" : ""}" data-action="nav-stake">Stake</a>
        <div class="nav-dropdown-wrap">
          <button type="button" class="nav-dropdown-btn" data-action="toggle-products">
            Products ${chevronSvg()}
          </button>
          <div class="nav-dropdown ${state.productsOpen ? "open" : ""}">
            <a href="#">Swap</a>
            <a href="#">Bridge</a>
            <a href="#">Market</a>
            <a href="#">Inscriber</a>
          </div>
        </div>
      </nav>
      <div class="header-actions">
        <button type="button" class="btn-pill btn-pill--ghost" data-action="open-evm">
          ${ethShort ? `ETH ${ethShort}` : "Connect ETH"}
        </button>
        <button type="button" class="btn-pill btn-pill--accent" data-action="open-btc">
          ${btcShort ? `BRC-20 ${btcShort}` : "Connect BRC-20"}
        </button>
      </div>
    </header>
  `;
}

function renderBtcModal() {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" data-stop="1">
        <button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button>
        <p class="modal-connect-header">Connect to</p>
        <div class="modal-brand">
          <img src="${LOGO_URL}" alt="TAP Protocol" class="brand-logo brand-logo--modal" width="120" height="26" decoding="async" />
        </div>
        <ul class="wallet-list">
          <li>
            <button type="button" data-action="btc-tap">
              <span class="wallet-icon wallet-icon--tap">T</span>
              Tap Wallet
            </button>
          </li>
          <li>
            <button type="button" data-action="btc-unisat">
              <span class="wallet-icon wallet-icon--unisat">S</span>
              UniSat Wallet
            </button>
          </li>
          <li>
            <button type="button" data-action="btc-xverse">
              <span class="wallet-icon wallet-icon--xverse">X</span>
              XVerse Wallet
            </button>
          </li>
        </ul>
        <p class="modal-brc20-hint">BRC-20 NAT 转出或质押需使用 Tap Wallet。UniSat / Xverse 可连接地址，但本页不会用它们发起 BRC-20 NAT 转账。</p>
      </div>
    </div>
  `;
}

function renderEvmModal() {
  const wallets = collectEvmWalletEntries();
  if (!wallets.length) {
    return `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal" data-stop="1">
          <button type="button" class="modal-close" data-action="close-modal">×</button>
          <p class="modal-connect-header">No EVM wallet</p>
        </div>
      </div>
    `;
  }
  const items = wallets
    .map(
      (w, i) => `
    <li>
      <button type="button" data-action="evm-pick" data-index="${i}">
        <span class="wallet-icon">${w.label.replace(/^[\s\W]+/, "").slice(0, 2)}</span>
        ${w.label}
      </button>
    </li>
  `
    )
    .join("");
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" data-stop="1">
        <button type="button" class="modal-close" data-action="close-modal">×</button>
        <p class="modal-connect-header">Connect to</p>
        <div class="modal-brand">
          <img src="${LOGO_URL}" alt="TAP Protocol" class="brand-logo brand-logo--modal" width="120" height="26" decoding="async" />
          <span class="modal-brand-sub">Ethereum</span>
        </div>
        <ul class="wallet-list">${items}</ul>
      </div>
    </div>
  `;
}

function ethNetworkSelectHtml() {
  const chains = evmChainsForUi();
  const opts = chains
    .map(
      (c) =>
        `<option value="${c.chainId}" ${state.evmChainId === c.chainId ? "selected" : ""}>${c.name}</option>`
    )
    .join("");
  return `
    <div class="select-row select-row--network">
      <span class="network-prefix">Network</span>
      <select data-field="eth-network" class="network-select">${opts}</select>
      ${chevronSvg()}
    </div>
  `;
}

function bridgeAssetSelectHtml() {
  if (!state.ethToTap) {
    return `<div class="token-select-wrap token-select-wrap--static">NAT</div>`;
  }
  const natSel = state.bridgeAsset === "NAT" ? "selected" : "";
  const nativeSel = state.bridgeAsset === "NATIVE" ? "selected" : "";
  const nativeLabel = nativeAssetLabel();
  return `
    <div class="token-select-wrap">
      <select data-field="bridge-asset">
        <option value="NAT" ${natSel}>NAT</option>
        <option value="NATIVE" ${nativeSel}>${nativeLabel}</option>
      </select>
    </div>
  `;
}

function renderBridge() {
  const fromEth = state.ethToTap;
  const fromLabel = fromEth ? "Ethereum" : "TAP Protocol";
  const toLabel = fromEth ? "TAP Protocol" : "Ethereum";
  const summaryNet = fromEth ? "TAP Protocol" : "Ethereum";
  const bridgeCta = fromEth ? "Bridge to TAP Protocol" : "Bridge to Ethereum";

  const fromGas = fromEth ? state.ethGasText : state.tapGasText;
  const toGas = fromEth ? state.tapGasText : state.ethGasText;
  const fromGasLabel = fromEth ? "Ethereum gas fee" : "TAP Protocol gas fee";
  const toGasLabel = fromEth ? "TAP Protocol gas fee" : "Ethereum gas fee";

  const connectFromLabel = fromEth
    ? "Connect Ethereum Wallet"
    : "Connect Bitcoin Wallet";
  const connectToLabel = fromEth
    ? "Connect Bitcoin Wallet"
    : "Connect Ethereum Wallet";

  const needFrom = fromEth ? !state.ethAddress : !state.btcAddress;
  const needTo = fromEth ? !state.btcAddress : !state.ethAddress;

  const summaryAsset =
    !fromEth || state.bridgeAsset === "NAT"
      ? "NAT"
      : nativeAssetLabel();

  const amountBlock = `
          <div class="amount-row">
            <input class="amount-input" type="text" inputmode="decimal" placeholder="0" value="${state.amount}" data-field="amount" />
            ${bridgeAssetSelectHtml()}
          </div>
          <div class="meta-row"><span>${fromEth ? state.balanceText : "Balance: —"}</span></div>
  `;

  return `
    <main class="main-wrap">
      <div class="bridge-card">
        <div class="panel">
          <div class="field-label">From: ${fromLabel}</div>
          <div class="select-row">
            <span>From: ${fromLabel}</span>
            ${chevronSvg()}
          </div>
          ${fromEth ? ethNetworkSelectHtml() : ""}
          ${amountBlock}
          <div class="meta-row">
            <span>${fromGasLabel}</span>
            <strong data-eth-gas-live="${fromEth ? "1" : "0"}">${fromGas}</strong>
          </div>
          <button type="button" class="btn-block" data-action="connect-from" ${needFrom ? "" : "disabled"}>
            ${needFrom ? connectFromLabel : "Connected"}
          </button>
        </div>

        <div class="swap-fab">
          <button type="button" aria-label="Swap direction" data-action="swap">${swapArrowsSvg()}</button>
        </div>

        <div class="panel">
          <div class="field-label">To: ${toLabel}</div>
          <div class="select-row">
            <span>To: ${toLabel}</span>
            ${chevronSvg()}
          </div>
          ${!fromEth ? ethNetworkSelectHtml() : ""}
          <div class="meta-row">
            <span>${toGasLabel}</span>
            <strong data-eth-gas-live="${!fromEth ? "1" : "0"}">${toGas}</strong>
          </div>
          <button type="button" class="btn-block" data-action="connect-to" ${needTo ? "" : "disabled"}>
            ${needTo ? connectToLabel : "Connected"}
          </button>
        </div>

        <div class="summary-panel">
          <h3>Summary</h3>
          <p>You will receive on ${summaryNet}: <strong data-summary-amount style="color:var(--text)">${state.amount || "0"}</strong> ${summaryAsset}</p>
          <button type="button" class="btn-block" style="margin-top:1rem" data-action="bridge" ${needFrom ? "disabled" : ""}>
            ${bridgeCta}
          </button>
        </div>
      </div>
    </main>
  `;
}

function shortAddr(addr) {
  const s = String(addr);
  if (s.startsWith("0x") && s.length > 14) return `${s.slice(0, 6)}…${s.slice(-4)}`;
  if (s.length > 16) return `${s.slice(0, 8)}…${s.slice(-6)}`;
  return s;
}

function stakeAssetLabel() {
  return state.stakeAsset === "brc20_nat" ? "Bitcoin — BRC-20 NAT" : "Ethereum — NAT (ERC-20)";
}

function renderStake() {
  const assetMenuOpen = state.stakeDropdownOpen === "asset";
  const periodMenuOpen = state.stakeDropdownOpen === "period";
  const assetOptionsHtml = [
    { id: "evm_nat", label: "Ethereum — NAT (ERC-20)" },
    { id: "brc20_nat", label: "Bitcoin — BRC-20 NAT" },
  ]
    .map(
      (o) => `
      <button type="button" role="menuitem" class="custom-dd-option ${state.stakeAsset === o.id ? "is-active" : ""}" data-stake-pick-asset="${o.id}">
        ${o.label}
      </button>`
    )
    .join("");
  const periodOptionsHtml = STAKE_PERIODS.map(
    (p) => `
      <button type="button" role="menuitem" class="custom-dd-option ${state.stakePeriodId === p.id ? "is-active" : ""}" data-stake-pick-period="${p.id}">
        ${p.label}
      </button>`
  ).join("");
  const period = STAKE_PERIODS.find((p) => p.id === state.stakePeriodId) || STAKE_PERIODS[1];
  const rewardPreview = stakeRewardEstimateText(state.stakeAmount, state.stakePeriodId);
  const needWallet =
    state.stakeAsset === "evm_nat" ? !state.ethAddress : !state.btcAddress;
  const connectLabel =
    state.stakeAsset === "evm_nat" ? "Connect Ethereum wallet" : "Connect Bitcoin wallet (BRC-20)";
  const gasBlock =
    state.stakeAsset === "evm_nat"
      ? `
          <div class="meta-row">
            <span>Ethereum gas (mainnet)</span>
            <strong data-eth-gas-live="1">${state.ethGasText}</strong>
          </div>`
      : `
          <div class="meta-row">
            <span>Network fee</span>
            <strong>${state.tapGasText}</strong>
          </div>`;

  return `
    <main class="main-wrap">
      <div class="bridge-card">
        <div class="panel">
          <div class="field-label">Stake NAT</div>
          <div class="custom-dd-wrap" data-dropdown-wrap="1">
            <div class="select-row select-row--network select-row--dd">
              <span class="network-prefix">Asset</span>
              <button type="button" class="custom-dd-trigger" data-action="stake-dd-asset" aria-expanded="${assetMenuOpen}" aria-haspopup="menu">
                <span class="custom-dd-value">${stakeAssetLabel()}</span>
                ${chevronSvg()}
              </button>
            </div>
            <div class="custom-dd-menu ${assetMenuOpen ? "is-open" : ""}" role="menu" data-dropdown-menu="1">
              ${assetOptionsHtml}
            </div>
          </div>
          <div class="custom-dd-wrap" data-dropdown-wrap="1">
            <div class="select-row select-row--network select-row--dd">
              <span class="network-prefix">Lock</span>
              <button type="button" class="custom-dd-trigger" data-action="stake-dd-period" aria-expanded="${periodMenuOpen}" aria-haspopup="menu">
                <span class="custom-dd-value">${period.label}</span>
                ${chevronSvg()}
              </button>
            </div>
            <div class="custom-dd-menu ${periodMenuOpen ? "is-open" : ""}" role="menu" data-dropdown-menu="1">
              ${periodOptionsHtml}
            </div>
          </div>
          <div class="stake-apr-row">
            <span class="field-label" style="margin:0">APR</span>
            <span class="stake-apr">${STAKE_APR_PERCENT}%</span>
          </div>
          <div class="amount-row" style="margin-top:0.65rem">
            <input class="amount-input" type="text" inputmode="decimal" placeholder="0" value="${state.stakeAmount}" data-field="stake-amount" />
            <div class="token-select-wrap token-select-wrap--static">NAT</div>
          </div>
          <div class="meta-row"><span data-stake-balance="1">${state.stakeBalanceText}</span></div>
          ${gasBlock}
          ${
            needWallet
              ? `<button type="button" class="btn-block" data-action="stake-connect">${connectLabel}</button>`
              : `<button type="button" class="btn-block" data-action="stake-submit">Confirm stake in wallet</button>`
          }
        </div>
        <div class="summary-panel">
          <h3>Summary</h3>
          <p>Lock <strong style="color:var(--text)">${period.label}</strong> · APR <strong style="color:var(--text)">${STAKE_APR_PERCENT}%</strong></p>
          <p style="margin-top:0.5rem">Amount: <strong data-stake-summary-amt style="color:var(--text)">${state.stakeAmount || "0"}</strong> NAT</p>
          <p style="margin-top:0.5rem">Simple yield preview: <strong data-stake-reward style="color:var(--text)">${rewardPreview}</strong></p>
          <p class="stake-disclaimer">
            On-chain action: NAT is transferred to the pool address on the chain you selected (${shortAddr(
              state.stakeAsset === "evm_nat" ? evmRecipientAddress() : brc20RecipientAddress()
            )}). APR and lock duration are product terms shown here for your records; enforcement is off-chain unless you use an audited staking contract.
          </p>
        </div>
      </div>
    </main>
  `;
}

function render() {
  if (state.ethToTap && state.bridgeAsset === "NAT" && state.evmChainId !== NAT_EVM_CHAIN_ID) {
    state.evmChainId = NAT_EVM_CHAIN_ID;
  }
  const toast = state.toast
    ? `<div class="toast" role="status">${state.toast}</div>`
    : "";
  let modal = "";
  if (state.modal === "btc") modal = renderBtcModal();
  else if (state.modal === "evm") modal = renderEvmModal();

  const main = state.view === "bridge" ? renderBridge() : renderStake();
  document.getElementById("app").innerHTML = renderHeader() + main + modal + toast;
  bind();
}

function bind() {
  document.querySelectorAll("[data-action='toggle-products']").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      state.productsOpen = !state.productsOpen;
      render();
    });
  });

  document.querySelectorAll("[data-action='nav-bridge']").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      state.view = "bridge";
      state.productsOpen = false;
      state.stakeDropdownOpen = null;
      render();
    });
  });

  document.querySelectorAll("[data-action='nav-stake']").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      state.view = "stake";
      state.productsOpen = false;
      state.stakeDropdownOpen = null;
      if (state.stakeAsset === "evm_nat") {
        state.evmChainId = NAT_EVM_CHAIN_ID;
      }
      await refreshEthGas();
      await refreshStakeBalance();
      render();
    });
  });

  document.querySelectorAll("[data-action='open-evm']").forEach((el) => {
    el.addEventListener("click", () => {
      openEvmWalletModal();
    });
  });

  document.querySelectorAll("[data-action='open-btc']").forEach((el) => {
    el.addEventListener("click", () => {
      state.modal = "btc";
      render();
    });
  });

  document.querySelectorAll("[data-action='close-modal']").forEach((el) => {
    el.addEventListener("click", () => {
      state.modal = null;
      render();
    });
  });

  document.querySelectorAll("[data-stop='1']").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
  });

  document.querySelectorAll("[data-action='swap']").forEach((el) => {
    el.addEventListener("click", swapDirection);
  });

  const amountEl = document.querySelector("[data-field='amount']");
  if (amountEl) {
    amountEl.addEventListener("input", (e) => {
      state.amount = e.target.value;
      const sumEl = document.querySelector("[data-summary-amount]");
      if (sumEl) sumEl.textContent = state.amount || "0";
    });
  }

  document.querySelectorAll("[data-field='eth-network']").forEach((el) => {
    el.addEventListener("change", async (e) => {
      state.evmChainId = Number(e.target.value);
      await trySwitchWalletToSelectedChain();
      await refreshEthGas();
      await refreshFromBalance();
      render();
    });
  });

  document.querySelectorAll("[data-field='bridge-asset']").forEach((el) => {
    el.addEventListener("change", async (e) => {
      state.bridgeAsset = e.target.value === "NATIVE" ? "NATIVE" : "NAT";
      if (state.bridgeAsset === "NAT") {
        state.evmChainId = NAT_EVM_CHAIN_ID;
      }
      await trySwitchWalletToSelectedChain();
      await refreshEthGas();
      await refreshFromBalance();
      render();
    });
  });

  document.querySelectorAll("[data-action='connect-from']").forEach((el) => {
    el.addEventListener("click", () => {
      if (state.ethToTap) {
        openEvmWalletModal();
      } else {
        state.modal = "btc";
        render();
      }
    });
  });

  document.querySelectorAll("[data-action='connect-to']").forEach((el) => {
    el.addEventListener("click", () => {
      if (state.ethToTap) {
        state.modal = "btc";
        render();
      } else {
        openEvmWalletModal();
      }
    });
  });

  document.querySelectorAll("[data-action='bridge']").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        if (state.ethToTap) {
          await bridgeFromEvm();
        } else {
          await bridgeFromTap();
        }
      } catch (err) {
        showToast(state.ethToTap ? decodeEvmTxError(err) : err?.shortMessage || err?.reason || err?.message || "Failed");
      }
    });
  });

  document.querySelectorAll("[data-action='btc-tap']").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        await connectTapWallet();
        showToast("Tap Wallet connected");
      } catch (err) {
        showToast(err.message || "Connection failed");
      }
    });
  });

  document.querySelectorAll("[data-action='btc-unisat']").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        await connectUniSat();
        showToast("UniSat connected");
      } catch (err) {
        showToast(err.message || "Connection failed");
      }
    });
  });

  document.querySelectorAll("[data-action='btc-xverse']").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        await connectXverse();
        showToast("Xverse connected");
      } catch (err) {
        showToast(err.message || "Connection failed");
      }
    });
  });

  document.querySelectorAll("[data-action='evm-pick']").forEach((el) => {
    el.addEventListener("click", async () => {
      const i = Number(el.getAttribute("data-index"));
      const wallets = collectEvmWalletEntries();
      const w = wallets[i];
      if (!w?.provider) return;
      try {
        await connectEvmProvider(w.provider);
        showToast(`${w.label} connected`);
      } catch (err) {
        showToast(err.message || "Connection rejected");
      }
    });
  });

  document.querySelectorAll("[data-action='stake-connect']").forEach((el) => {
    el.addEventListener("click", () => {
      if (state.stakeAsset === "evm_nat") openEvmWalletModal();
      else {
        state.modal = "btc";
        render();
      }
    });
  });

  document.querySelectorAll("[data-field='stake-amount']").forEach((el) => {
    el.addEventListener("input", (e) => {
      state.stakeAmount = e.target.value;
      const sum = document.querySelector("[data-stake-summary-amt]");
      const rew = document.querySelector("[data-stake-reward]");
      if (sum) sum.textContent = state.stakeAmount || "0";
      if (rew) rew.textContent = stakeRewardEstimateText(state.stakeAmount, state.stakePeriodId);
    });
  });

  document.querySelectorAll("[data-action='stake-dd-asset']").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      state.stakeDropdownOpen = state.stakeDropdownOpen === "asset" ? null : "asset";
      render();
    });
  });

  document.querySelectorAll("[data-action='stake-dd-period']").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      state.stakeDropdownOpen = state.stakeDropdownOpen === "period" ? null : "period";
      render();
    });
  });

  document.querySelectorAll("[data-stake-pick-asset]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = el.getAttribute("data-stake-pick-asset");
      state.stakeAsset = id === "brc20_nat" ? "brc20_nat" : "evm_nat";
      state.stakeDropdownOpen = null;
      if (state.stakeAsset === "evm_nat") {
        state.evmChainId = NAT_EVM_CHAIN_ID;
      }
      await refreshEthGas();
      await refreshStakeBalance();
      render();
    });
  });

  document.querySelectorAll("[data-stake-pick-period]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      state.stakePeriodId = el.getAttribute("data-stake-pick-period") || "1m";
      state.stakeDropdownOpen = null;
      const rew = document.querySelector("[data-stake-reward]");
      if (rew) rew.textContent = stakeRewardEstimateText(state.stakeAmount, state.stakePeriodId);
      render();
    });
  });

  document.querySelectorAll("[data-dropdown-menu='1']").forEach((menu) => {
    menu.addEventListener("click", (e) => e.stopPropagation());
  });

  document.querySelectorAll("[data-action='stake-submit']").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        await submitStake();
      } catch (err) {
        if (isNeedTapWalletError(err)) {
          showToast(TAP_WALLET_TOAST_ZH);
          return;
        }
        const msg =
          state.stakeAsset === "evm_nat" ? decodeEvmTxError(err) : err?.message || "Failed";
        showToast(msg);
      }
    });
  });
}

let __stakeDdDocCloseBound = false;
function ensureStakeDropdownDocClose() {
  if (typeof document === "undefined" || __stakeDdDocCloseBound) return;
  __stakeDdDocCloseBound = true;
  document.addEventListener("click", () => {
    if (state.view !== "stake" || !state.stakeDropdownOpen) return;
    state.stakeDropdownOpen = null;
    render();
  });
}

document.addEventListener("click", (e) => {
  if (!state.productsOpen) return;
  if (e.target.closest?.(".nav-dropdown-wrap")) return;
  state.productsOpen = false;
  render();
});

window.addEventListener("tapprotocol#initialized", () => {
  render();
});

ensureEip6963();
requestEip6963Wallets();
ensureStakeDropdownDocClose();

render();
refreshEthGas().then(() => render());
startGasPolling();
