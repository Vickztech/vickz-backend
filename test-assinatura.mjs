// Teste unitário da verificação (sem rede, sem wrangler). Uso: node test-assinatura.mjs  (na pasta vickz-api)
import { createHmac } from "node:crypto";
import { verificarAssinaturaWebhook as v } from "./src/stripe.js";
const S = "whsec_teste_unitario", corpo = '{"a":1}', agora = 1_800_000_000;
const sig = (t, c = corpo, s = S) => createHmac("sha256", s).update(`${t}.${c}`).digest("hex");
const res = []; const ok = (n, c) => res.push(`${c ? "OK  " : "FALHOU"} ${n}`);
const hdr = (t, ...v1) => `t=${t},` + v1.map((x) => `v1=${x}`).join(",");
ok("assinatura válida e recente", await v(corpo, hdr(agora, sig(agora)), S, agora));
ok("válida com 2 v1 (rotação), 2º correto", await v(corpo, hdr(agora, "00".repeat(32), sig(agora)), S, agora));
ok("corpo adulterado", !(await v(corpo + " ", hdr(agora, sig(agora)), S, agora)));
ok("segredo errado", !(await v(corpo, hdr(agora, sig(agora, corpo, "outro")), S, agora)));
ok("replay: 301s antigo, assinatura válida", !(await v(corpo, hdr(agora - 301, sig(agora - 301)), S, agora)));
ok("na borda: 300s antigo ainda vale", await v(corpo, hdr(agora - 300, sig(agora - 300)), S, agora));
ok("timestamp no futuro > 300s", !(await v(corpo, hdr(agora + 301, sig(agora + 301)), S, agora)));
ok("header vazio", !(await v(corpo, "", S, agora)));
ok("header sem v1", !(await v(corpo, `t=${agora}`, S, agora)));
ok("header sem t", !(await v(corpo, `v1=${sig(agora)}`, S, agora)));
ok("t não numérico", !(await v(corpo, hdr("abc", sig(agora)), S, agora)));
ok("v1 não-hex", !(await v(corpo, hdr(agora, "zzzz"), S, agora)));
ok("v1 hex de tamanho errado", !(await v(corpo, hdr(agora, "ab"), S, agora)));
ok("lixo no header", !(await v(corpo, ",,=,t", S, agora)));
let lancou = false; try { await v(corpo, hdr(agora, sig(agora)), undefined, agora); } catch (e) { lancou = /não configurado/.test(e.message); }
ok("secret ausente => erro de configuração (não 'válido')", lancou);
console.log(res.join("\n")); process.exit(res.some((l) => l.startsWith("FALHOU")) ? 1 : 0);
