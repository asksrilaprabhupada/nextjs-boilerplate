import asyncio
from playwright.async_api import async_playwright
from playwright_stealth import stealth_async


async def check():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
        )
        page = await context.new_page()
        await stealth_async(page)

        print("Loading...")
        await page.goto(
            "https://vedabase.io/en/library/bg/1/advanced-view/",
            wait_until="domcontentloaded",
            timeout=60000,
        )
        for i in range(20):
            await asyncio.sleep(2)
            body = await page.evaluate("() => document.body.innerText.substring(0, 200)")
            if "TEXT 1" in body:
                print(f"  Ready ({(i+1)*2}s)")
                break

        await asyncio.sleep(2)

        result = await page.evaluate("""
            () => {
                const container = document.querySelector(".av-verses");
                if (!container) return "NO .av-verses FOUND";

                let out = "=== .av-verses DIRECT CHILDREN (first 30) ===\\n";
                const kids = Array.from(container.children).slice(0, 30);
                for (let i = 0; i < kids.length; i++) {
                    const el = kids[i];
                    const txt = (el.innerText || "").substring(0, 80).replace(/\\n/g, " ");
                    out += i + ": " + el.tagName + " [" + (el.className || "") + "] => " + txt + "\\n";

                    // Show grandchildren for first 3 elements
                    if (i < 3 && el.children.length > 0) {
                        const grandkids = Array.from(el.children).slice(0, 10);
                        for (const gk of grandkids) {
                            const gtxt = (gk.innerText || "").substring(0, 60).replace(/\\n/g, " ");
                            out += "   child: " + gk.tagName + " [" + (gk.className || "") + "] => " + gtxt + "\\n";
                        }
                    }
                }

                return out;
            }
        """)

        print(result)
        await browser.close()


asyncio.run(check())