// Optional browser regression test. Start a static server, then run with
// playwright-core installed and CHROMIUM_PATH set to a Chromium executable.
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const url = process.env.TEST_BASE_URL || 'http://127.0.0.1:8080/';
const sizes = [[320,568],[390,844],[768,1024],[568,320],[1024,768],[1366,768],[1920,1080]];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--single-process','--no-zygote'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    await page.goto(url);
    await page.evaluate(() => { localStorage.setItem('bazaar_tut_done','1'); startGame(null,false); });
    const box = await page.evaluate(() => {
      const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return { x:b.x, y:b.y, width:b.width, height:b.height, bottom:b.bottom }; };
      return {bodyHeight:document.body.scrollHeight, pageWidth:document.documentElement.scrollWidth, main:r('.game-body'), center:r('.center-panel'), nav:r('.left-panel')};
    });
    assert(box.bodyHeight <= height + 1, `${width}x${height}: page scrolls vertically`);
    assert(box.pageWidth <= width + 1, `${width}x${height}: page overflows horizontally`);
    assert(box.main.width >= width - 1, `${width}x${height}: game does not fill width`);
    assert(box.center.width > 0 && box.center.height > 50, `${width}x${height}: no playable content`);
    if(width > 900) {
      assert(await page.locator('.center-panel').evaluate(el => el.scrollHeight <= el.clientHeight + 1), `${width}x${height}: initial market needs scrolling`);
    }
    if(width <= 900) {
      assert(box.nav.height < 100 && box.nav.bottom <= height + 1, `${width}x${height}: broken mobile dock`);
      await page.evaluate(() => { document.getElementById('nextDayBtn').textContent = '⏳ انتظار (۶۰)'; });
      assert(await page.locator('.left-panel').evaluate(el => el.getBoundingClientRect().height < 100), 'waiting text expanded the dock');
      await page.click('#nav-status');
      assert(await page.locator('.right-panel').isVisible(), 'status panel missing');
      assert(!(await page.locator('.center-panel').isVisible()), 'status overlaps center');
      await page.click('#nav-market');
      assert(await page.locator('.center-panel').isVisible(), 'market did not return');
      assert(!(await page.locator('.right-panel').isVisible()), 'status remained open');
    }
    await page.click('#buyBtn-apple');
    assert(await page.locator('#tradeOverlay').isVisible(), 'trade modal did not open');
    await page.fill('#tradeQty', '2');
    await page.click('#tradeConfirmBtn');
    assert.equal(await page.evaluate(() => G.warehouse.find(w => w.id === 'apple').qty), 2, 'trade did not complete');
    await page.click('#nav-warehouse');
    assert(await page.locator('#tab-warehouse').isVisible(), 'warehouse unavailable');
    await page.click('#nav-internet');
    assert(await page.locator('#tab-internet').isVisible(), 'internet tab unavailable');
    await page.evaluate(() => { G.internet = 1000; });
    await page.click('#nav-browser');
    assert(await page.locator('#tab-browser').isVisible(), 'browser unavailable');
    await page.click('#btab-chart');
    assert(await page.locator('#bpanel-chart').isVisible(), 'chart unavailable');
    await page.click('#nav-market');
    if(width <= 900) {
      await page.evaluate(() => {
        showOnlineOpponentPanel({money:2000,startMoney:2000,debt:0,warehouse:[],darkWarehouse:[]}, 'حریف');
        showTab('status');
      });
      assert(await page.locator('#rankingPanel').isVisible(), 'online opponent inaccessible');
      await page.setViewportSize({width:1024, height:768});
      assert(await page.locator('.center-panel').isVisible(), 'market stayed hidden after resizing to desktop');
      assert(await page.locator('.right-panel').isVisible(), 'desktop status panel missing');
    }
    console.log(`${width}x${height}: OK`);
  }
  assert.deepEqual(errors, [], `browser errors: ${errors.join(', ')}`);
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
