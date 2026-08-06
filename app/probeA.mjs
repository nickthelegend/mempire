import { chromium } from 'playwright';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
const seed = new Uint8Array(32);
Buffer.from('mempire-browser-e2e-a-v1').copy(Buffer.from(seed.buffer));
const kp = nacl.sign.keyPair.fromSeed(seed);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
await ctx.addInitScript((sk) => localStorage.setItem('mempire_guest_sk', sk), bs58.encode(kp.secretKey));
const page = await ctx.newPage();
page.on('console', m => { if (m.type()==='error') console.log('ERR:', m.text().slice(0,160)); });
await page.goto('https://play.mempire.fun', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  const w = ms => new Promise(r=>setTimeout(r,ms));
  document.querySelector('button')?.click(); await w(700);
  [...document.querySelectorAll('button')].find(b=>/guest/i.test(b.textContent))?.click(); await w(1800);
  [...document.querySelectorAll('button')].find(b=>/^skip$/i.test(b.textContent.trim()))?.click();
});
await page.waitForTimeout(5000);
await page.evaluate(() => { window.location.hash = '#/deck'; });
await page.waitForTimeout(2500);
const info = await page.evaluate(() => {
  const t = document.body.innerText;
  return {
    deckHeader: t.match(/\d\/8/)?.[0] ?? null,
    deckCardsShown: [...document.querySelectorAll('button')].filter(b=>/\$[A-Z]{2,6} \d/.test(b.textContent)).length,
    collectionText: t.includes('Everything you own') ? 'all enlisted' : (t.match(/COLLECTION[\s\S]{0,80}/)?.[0] ?? '').replace(/\n/g,' '),
  };
});
console.log('DECK:', JSON.stringify(info));
await page.evaluate(() => { window.location.hash = '#/'; });
await page.waitForTimeout(2500);
const arena = await page.evaluate(() => {
  const t = document.body.innerText;
  return t.match(/(?:Escrowed onchain|.*not minted onchain.*|.*unreachable.*|.*fund .*)/)?.[0]?.slice(0,110) ?? 'none';
});
console.log('ARENA:', arena);
await b.close();
