"""
tests/browser-check.py: drives the real page in Chromium (Playwright) and checks that it computes on input.
Run:  python3 tests/browser-check.py
It serves this folder on a free local port, opens index.html, works through the fixes, the reminders, a payment
with and without the sync, the clock, the rules and a new booking, refuses bad input, and fails on any console
or page error. Screenshots go to tests/.
"""
import asyncio, functools, http.server, pathlib, socketserver, threading
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
passed = failed = 0


def ok(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS', name)
    else:
        failed += 1
        print('  FAIL', name, detail)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


async def main():
    srv, port = serve()
    base = f'http://127.0.0.1:{port}/index.html'
    errors = []
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        k = lambda key: pg.locator(f'.kpi[data-k={key}] b').inner_text()
        code = lambda bid, pane='need': pg.locator(f'#{pane}Body tr[data-id="{bid}"]').get_attribute('data-code')

        print('\n1. The page loads with the invented tour company')
        await pg.goto(base)
        await pg.wait_for_selector('#needBody tr')
        ok('10 trips in the next 14 days, 45% of their value paid', await k('trips') == '10' and await k('paid') == '45%')
        ok('232,500 XPF unpaid on upcoming trips', await k('unpaid') == '232,500 XPF')
        ok('11 bookings need something, 2 reminders due, 61,000 XPF of refunds', await k('need') == '11' and await k('rem') == '2' and await k('refund') == '61,000 XPF')
        ok('the most urgent row is first (trip done, still unpaid)', await pg.locator('#needBody tr').first.get_attribute('data-code') == 'PAST_UNPAID')
        ok('today shows Mon 26 Oct', 'Mon 26 Oct' in await pg.inner_text('#todayLbl'))

        print('\n2. Fixes that write back')
        await pg.click('#needBody button[data-act=xeroPaid][data-id="BK-24055"]')
        ok('marking INV-0421 paid moves BK-24055 to the Bookeo step', await code('BK-24055') == 'PAID_BOOKEO_UNPAID')
        await pg.click('#needBody button[data-act=bookeoPaid][data-id="BK-24055"]')
        ok('marking Bookeo paid takes it off the list (10 left)', await pg.locator('#needBody tr[data-id="BK-24055"]').count() == 0 and await k('need') == '10')
        await pg.click('#needBody button[data-act=newLink][data-id="BK-24076"]')
        ok('a new link for the refused card is drafted in French', 'carte a été refusée' in await pg.inner_text('#msgbox'))
        await pg.click('#needBody button[data-act=refund][data-id="BK-24067"]')
        ok('recording the cancelled refund leaves the invoice to void', await code('BK-24067') == 'CANCELLED_INVOICE_OPEN')
        await pg.click('#needBody button[data-act=void][data-id="BK-24067"]')
        ok('voiding it clears the cancellation and refunds due drop to 42,000 XPF', await pg.locator('#needBody tr[data-id="BK-24067"]').count() == 0 and await k('refund') == '42,000 XPF')

        print('\n3. Reminders in the customer\'s language')
        await pg.click('.side button[data-tab=reminders]')
        ok('2 reminders listed', await pg.locator('#rems .rem').count() == 2)
        first = pg.locator('#rems .rem[data-id="BK-24058"]')
        ok('Hinano\'s reminder is in French', 'petit rappel' in await first.inner_text())
        await first.locator('button[data-lang=en]').click()
        ok('switching to EN redrafts it in English', 'a quick reminder' in await pg.locator('#rems .rem[data-id="BK-24058"]').inner_text())
        await pg.locator('#rems .rem[data-id="BK-24058"] button[data-act=remind]').click()
        ok('sending it shows the English text and 1 reminder is left', 'Hi Hinano' in await pg.inner_text('#msgbox') and await k('rem') == '1')

        print('\n4. A payment lands, with the sync failing')
        await pg.click('.side button[data-tab=all]')
        await pg.check('#syncFail')
        await pg.click('#allBody button[data-pay="PZ-88212"]')
        ok('the checker catches it: paid on PayZen, still open in Xero', await code('BK-24063', 'all') == 'PAID_XERO_OPEN')
        await pg.uncheck('#syncFail')
        await pg.click('#allBody button[data-pay="PZ-88225"]')
        ok('a normal payment is matched at once', await code('BK-24073', 'all') == 'OK')

        print('\n5. The clock and the rules')
        await pg.click('#nextWeek')
        ok('a week on, today is Mon 2 Nov', 'Mon 2 Nov' in await pg.inner_text('#todayLbl'))
        await pg.fill('#rDays', '0, 3')
        await pg.click('#rApply')
        ok('a 0-day reminder is refused', 'Reminder days must be' in await pg.inner_text('#ruleErr'))
        await pg.fill('#rDays', '14, 2')
        await pg.click('#rApply')
        ok('reminder days 14 and 2 are applied', (await pg.input_value('#rDays')) == '14, 2' and await pg.inner_text('#ruleErr') == '')

        print('\n6. Adding a booking')
        await pg.click('.side button[data-tab=add]')
        await pg.fill('#bDate', '2026-10-01')
        await pg.click('#bAdd')
        berr = await pg.inner_text('#bErr')
        ok('a booking with no name, a bad email and a past date is refused', all(x in berr for x in ['Customer name', 'valid email', 'in the past']), berr)
        await pg.fill('#bName', 'Hanna Berg')
        await pg.fill('#bEmail', 'hanna@example.com')
        await pg.select_option('#bAct', 'DIVE')
        await pg.fill('#bPax', '2')
        await pg.fill('#bDate', '2026-11-20')
        await pg.click('#bAdd')
        await pg.wait_for_selector('#allBody tr[data-id="BK-24077"]')
        ok('the new booking comes with its invoice and a PayZen link', 'PZ-88233' in await pg.locator('#allBody tr[data-id="BK-24077"]').inner_text())

        print('\n7. Export and reset')
        async with pg.expect_download() as dl:
            await pg.click('#csvBtn')
        d = await dl.value
        text = pathlib.Path(await d.path()).read_text()
        ok('the CSV downloads with every booking', text.startswith('Booking,Customer,Trip date') and len(text.strip().split('\n')) == 18 and d.suggested_filename == 'bookings-to-cash-2026-11-02.csv', len(text.strip().split('\n')))
        await pg.click('#resetBtn')
        ok('reset brings back the starting data', await k('need') == '11' and 'Mon 26 Oct' in await pg.inner_text('#todayLbl'))
        await pg.click('.side button[data-tab=need]')
        await pg.locator('#tool').scroll_into_view_if_needed()
        await pg.screenshot(path=str(ROOT / 'tests' / 'shot-desktop.png'))
        await pg.locator('#pricing').scroll_into_view_if_needed()
        await pg.screenshot(path=str(ROOT / 'tests' / 'shot-desktop-pricing.png'))

        print('\n8. Phone layout')
        mob = await br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pm = await mob.new_page()
        pm.on('pageerror', lambda e: errors.append(str(e)))
        await pm.goto(base)
        await pm.wait_for_selector('#needBody tr')
        ok('no sideways scrolling at 390px wide', await pm.evaluate('document.documentElement.scrollWidth') <= 390, await pm.evaluate('document.documentElement.scrollWidth'))
        await pm.locator('.kpis').scroll_into_view_if_needed()
        await pm.screenshot(path=str(ROOT / 'tests' / 'shot-mobile.png'))

        ok('zero console or page errors', not errors, errors)
        await br.close()
    srv.shutdown()
    print(f'\n{passed + failed} browser checks: {passed} passed, {failed} failed')
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    asyncio.run(main())
