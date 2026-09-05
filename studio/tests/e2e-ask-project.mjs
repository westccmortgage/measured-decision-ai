// Load the complete shipping page: a component-only test missed a missing script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { rows, planDocument } from './seed.mjs';

const root = path.resolve('.');
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox','--no-proxy-server','--use-gl=swiftshader','--enable-unsafe-swiftshader']});
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({viewport:{width,height:900}});
    await context.route('**://*/**', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const answer = {answer:'14 beams are required. Installation is not yet evidenced.', citations:[
      {source_id:'document:doc-1',opens:'document',document_id:'doc-1',label:'Blueprints-3001-Hutton.pdf',page_number:null},
      {source_id:'room:space-viewable',opens:'room',room_id:'space-viewable',label:'Bath #1 A203'},
      {source_id:'reconciliation:rec-1',opens:'comparison',record_id:'rec-1',label:'Beam comparison'},
    ],records_considered:3};
    await context.addInitScript(`window.__seed=${JSON.stringify({rows:{...rows,project_documents:[planDocument()]}, functions:{'project-search':answer}})};`);
    await context.addInitScript({path:'studio/tests/fake-supabase.js'});
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    console.log('opening', width);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/studio/?property=prop-1`,{waitUntil:'networkidle'});
    console.log('loaded', await page.title());
    await page.waitForFunction(() => document.querySelector('#ask-project')?.dataset.wired === '1', null, {timeout:12000});
    console.log('mounted');
    // Use the application's normal Results navigation, not a test mount.
    await page.locator('[data-focus-step="results"]').click();
    await page.locator('#ask-question').waitFor({state:'visible'});
    await page.locator('#ask-question').fill('How many beams are required?');
    await page.locator('#ask-submit').click();
    await page.locator('.ask-source-link').first().waitFor();
    assert.match(await page.locator('#ask-answer-text').innerText(), /14 beams/);
    assert.match(await page.locator('.ask-source-link').first().innerText(), /Whole document/);
    assert.equal(await page.evaluate(() => window.__rpcCalls.filter(c=>c.name==='project-search').length),1);
    // The document URL must open a real source, not silently land on Summary.
    await page.locator('.ask-source-link').first().click();
    await page.locator('#search-source-dialog').waitFor({state:'visible'});
    assert.match(await page.locator('#search-source-dialog').innerText(), /Blueprints-3001-Hutton.pdf/);
    assert.match(await page.locator('#search-source-dialog iframe').getAttribute('src'), /\/doc-1\?sig=/);
    assert.ok(await page.evaluate(() => window.__rpcCalls.some(c => c.args?.entity_type === 'project_document' && c.args?.record_id === 'doc-1')));
    assert.equal(errors.length,0,errors.join('\n'));
    console.log(`ALL OK: complete Studio → question → source document at ${width}px`);
    await context.close();
  }
} catch (error) { console.error(error); process.exitCode=1; } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
