// Optional integration test. Starts its own loopback Vite server and isolated Firefox profile.
// Requires Firefox and Node's built-in WebSocket; no AI requests or user browser data are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const profileRoot = await mkdtemp(join(tmpdir(), "zhuzi-browser-test-"));
const children = [];
let socket;
let context;
let sequence = 0;
const pending = new Map();

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startProcess(executable, args, expectedOutput) {
  const child = spawn(executable, args, { cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  await new Promise((resolve, reject) => {
    let log = "";
    const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${log}`)), 20000);
    const read = (data) => {
      log = (log + data).slice(-4000);
      if (expectedOutput.test(log)) { clearTimeout(timeout); resolve(); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Process exited (${code}): ${log}`)); });
  });
}

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Command timed out: ${method}`)); }, 15000);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await command("script.evaluate", {
    expression: `(async () => JSON.stringify(await (async () => { ${expression} })()))()`,
    target: { context }, awaitPromise: true
  });
  if (response.type === "exception") throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value === undefined ? undefined : JSON.parse(response.result.value);
}

async function wait(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(`return Boolean(${expression});`)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition timed out: ${expression}`);
}

async function click(id) {
  await evaluate(`document.getElementById(${JSON.stringify(id)}).click();`);
}

async function mock() {
  await evaluate(`
    window.__calls = 0;
    window.fetch = async (url, options) => {
      if (String(url) !== '/api/translate') throw new Error('Unexpected fetch');
      window.__calls++;
      window.__sent = JSON.parse(options.body).text;
      return new Promise(resolve => {
        window.__resolve = text => resolve(new Response(JSON.stringify({ translation: text }), { status: 200 }));
      });
    };
  `);
}

try {
  const sitePort = await availablePort();
  const browserPort = await availablePort();
  const siteUrl = `http://127.0.0.1:${sitePort}/`;
  const profile = join(profileRoot, "profile");
  await mkdir(profile);
  await startProcess(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(sitePort), "--strictPort"], /Local:/);
  await startProcess(process.env.FIREFOX_BIN ?? "firefox", ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", String(browserPort), "about:blank"], /WebDriver BiDi listening/);
  socket = new WebSocket(`ws://127.0.0.1:${browserPort}/session`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.type === "error") task.reject(new Error(JSON.stringify(message)));
    else task.resolve(message.result);
  });
 await command('session.new',{capabilities:{}});
 ({context}=await command('browsingContext.create',{type:'tab'}));
 await command('browsingContext.setViewport',{context,viewport:{width:1600,height:1000},devicePixelRatio:1});
 await command('browsingContext.navigate',{context,url:siteUrl,wait:'complete'});
 await wait('window.zhuzi && !document.getElementById("importZipButton").disabled');
 await evaluate(`const payload=window.zhuzi.getBackupPayload();const entry=payload.state.entries[0];entry.draft=Array.from({length:45},(_,i)=>'原文第'+i+'行，保持段落。').join('\\n');entry.lastSavedContent='';entry.versions=[];entry.current_version_id=null;entry.saved_translation='';localStorage.setItem('char300-lab-state-v2',JSON.stringify(payload.state));localStorage.setItem('char300-lab-opfs-upgrade-v1','upgraded');localStorage.setItem('zhuzi-changelog-seen-version','0.5.0');localStorage.setItem('zhuzi-storage-notice-dismissed-v1','true');const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle('char300',{create:true});const file=await dir.getFileHandle('checkpoint.json',{create:true});const writable=await file.createWritable();await writable.write(JSON.stringify(payload.state));await writable.close();`);
 await command('browsingContext.reload',{context,wait:'complete'});
 await wait('!document.getElementById("translateButton").disabled');
 await mock();
 await evaluate(`const e=document.getElementById('editor');e.setSelectionRange(5,12);e.scrollTop=120;window.__before={text:e.value,scroll:e.scrollTop,updated:window.zhuzi.getBackupPayload().state.entries[0].updated_at};`);
 await click('translateButton');
 await wait('window.__calls===1');
 assert.deepEqual(await evaluate(`return {main:getComputedStyle(document.querySelector('.main-panel')).display,side:getComputedStyle(document.querySelector('.side-panel')).display,panel:getComputedStyle(document.getElementById('translationPanel')).display,source:document.getElementById('translationSource').textContent===window.__before.text};`),{main:'none',side:'none',panel:'flex',source:true});
 await evaluate(`window.__resolve('First English.\\n\\nSecond paragraph.');`);
 await wait('!document.getElementById("translationSaveButton").classList.contains("hidden")');
 assert.equal(await evaluate(`return window.zhuzi.getBackupPayload().state.entries[0].saved_translation;`),'');
 await click('translationSaveButton');
 await wait('document.getElementById("translationSaveButton").textContent==="已保存"');
 const saved=await evaluate(`const entry=window.zhuzi.getBackupPayload().state.entries[0];return {text:entry.saved_translation,versions:entry.versions.length,updated:entry.updated_at===window.__before.updated};`);
 assert.deepEqual(saved,{text:'First English.\n\nSecond paragraph.',versions:0,updated:true});
 const screenshot=await command('browsingContext.captureScreenshot',{context});
 await writeFile(join(profileRoot, 'desktop.png'),Buffer.from(screenshot.data,'base64'));
 await click('translationBackButton');
 assert.deepEqual(await evaluate(`const e=document.getElementById('editor');return {text:e.value===window.__before.text,start:e.selectionStart,end:e.selectionEnd,scroll:e.scrollTop===window.__before.scroll};`),{text:true,start:5,end:12,scroll:true});
 await command('browsingContext.reload',{context,wait:'complete'});
 await wait('!document.getElementById("translationViewButton").disabled');
 await mock();
 await click('translationViewButton');
 assert.equal(await evaluate('return window.__calls;'),0);
 assert.equal(await evaluate('return document.getElementById("translationOutput").textContent;'),saved.text);
 assert.equal(await evaluate('return document.getElementById("translationSaveButton").classList.contains("hidden");'),true);
 await click('translationRetryButton');
 await wait('window.__calls===1');
 await click('translationSavedTab');
 await evaluate(`window.__resolve('Unsaved replacement');`);
 await wait('document.getElementById("translationCurrentTab").classList.contains("hidden")===false');
 assert.equal(await evaluate('return document.getElementById("translationOutput").textContent;'),saved.text);
 await click('translationCurrentTab');
 await wait('document.getElementById("translationOutput").textContent==="Unsaved replacement"');
 await click('translationBackButton');
 await click('translationViewButton');
 assert.equal(await evaluate('return document.getElementById("translationOutput").textContent;'),saved.text);
 await command('browsingContext.setViewport',{context,viewport:{width:600,height:850},devicePixelRatio:1});
 await wait('document.body.classList.contains("translation-stacked")');
 const mobile=await evaluate(`return {body:getComputedStyle(document.body).overflow,columns:getComputedStyle(document.querySelector('.translation-columns')).flexDirection,width:document.documentElement.scrollWidth,viewport:innerWidth,main:getComputedStyle(document.querySelector('.main-panel')).display};`);
 assert.equal(mobile.body,'auto');assert.equal(mobile.columns,'column');assert.ok(mobile.width<=mobile.viewport);assert.equal(mobile.main,'none');
 const mobileShot=await command('browsingContext.captureScreenshot',{context});
 await writeFile(join(profileRoot, 'mobile.png'),Buffer.from(mobileShot.data,'base64'));

 // Both backends failing must remain retryable after leaving and reopening the reader.
 await command('browsingContext.setViewport', { context, viewport: { width: 1600, height: 1000 } });
 await click('translationRetryButton');
 await wait('window.__calls === 2');
 await evaluate(`window.__resolve('Retryable English');`);
 await click('translationCurrentTab');
 await wait('document.getElementById("translationOutput").textContent === "Retryable English"');
 await evaluate(`
   const set = Storage.prototype.setItem;
   const getDirectory = navigator.storage.getDirectory;
   window.__restoreStorage = () => { Storage.prototype.setItem = set; navigator.storage.getDirectory = getDirectory; };
   Storage.prototype.setItem = () => { throw new Error('Synthetic quota error'); };
   navigator.storage.getDirectory = async () => { throw new Error('Synthetic OPFS failure'); };
 `);
 await click('translationSaveButton');
 await wait('document.getElementById("translationSaveStatus").textContent.includes("保存失败")');
 await evaluate('window.__restoreStorage();');
 await click('translationBackButton');
 await click('translationViewButton');
 assert.equal(await evaluate('return document.getElementById("translationSaveButton").textContent;'), '重试本地保存');
 await click('translationSaveButton');
 await wait('document.getElementById("translationSaveStatus").textContent.includes("本地兼容存储")');
 assert.equal(await evaluate('return localStorage.getItem("char300-lab-opfs-upgrade-v1");'), 'failed');
 await command('browsingContext.reload', { context, wait: 'complete' });
 await wait('!document.getElementById("translationViewButton").disabled');
 // Legacy migration notice may be shown after deliberately falling back; dismiss only test dialogs.
 await evaluate(`document.querySelectorAll('.notice-backdrop').forEach(element => element.classList.add('hidden'));`);
 await click('translationViewButton');
 assert.equal(await evaluate('return document.getElementById("translationOutput").textContent;'), 'Retryable English');

 // Offline saved reading and copying use only the visible local text.
 await evaluate(`
   Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
   Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text; } } });
   window.dispatchEvent(new Event('offline'));
 `);
 assert.equal(await evaluate('return document.getElementById("translationRetryButton").disabled;'), true);
 await click('translationCopyButton');
 await wait('window.__copied === "Retryable English"');
 await evaluate(`delete navigator.onLine; window.dispatchEvent(new Event('online'));`);
 await click('translationBackButton');

 // Historical version selection survives entering and returning from the reader.
 await evaluate(`
   const state = window.zhuzi.getBackupPayload().state;
   const entry = state.entries[0];
   const stats = { text_units: 3, punctuation_units: 1, total_units: 4, han_units: 3, latin_units: 0, number_units: 0 };
   entry.versions = ['早期原文。', '最新版本。'].map((content, index) => ({
     version_id: 'version-' + index, entry_id: entry.entry_id, content,
     created_at: entry.date_key + 'T0' + index + ':00:00.000Z', token_stats: stats,
     diff_from_previous: [], is_initial: index === 0
   }));
   entry.current_version_id = 'version-1';
   localStorage.setItem('char300-lab-state-v2', JSON.stringify(state));
 `);
 await command('browsingContext.reload', { context, wait: 'complete' });
 await wait('!document.getElementById("translationViewButton").disabled');
 await evaluate(`
   document.querySelectorAll('.notice-backdrop').forEach(element => element.classList.add('hidden'));
   document.querySelector('[data-version-id="version-0"]').click();
 `);
 await mock();
 await click('translateButton');
 await wait('window.__calls === 1');
 assert.equal(await evaluate('return window.__sent;'), '早期原文。');
 assert.equal(await evaluate('return document.getElementById("translationBackButton").textContent;'), '返回版本阅读');
 await click('translationBackButton');
 await evaluate(`window.__resolve('Late old-version result');`);
 await wait('getComputedStyle(document.getElementById("translationPanel")).display === "none"');
 assert.equal(await evaluate(`return document.querySelector('.version-item.active').dataset.versionId;`), 'version-0');
 assert.equal(await evaluate('return window.zhuzi.getBackupPayload().state.entries[0].saved_translation;'), 'Retryable English');
 console.log('PASS: desktop/mobile reading, explicit save, OPFS refresh, unsaved-result isolation, return selection/scroll, saved tabs, offline copy, historical source, late responses, failed-save retry after reopening.');

} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    if (context) await command("browsingContext.close", { context }).catch(() => {});
    await command("session.end").catch(() => {});
    socket.close();
  }
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit").catch(() => {});
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(force);
  }
  await rm(profileRoot, { recursive: true, force: true });
}
