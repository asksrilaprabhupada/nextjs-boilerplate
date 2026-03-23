import asyncio
from playwright.async_api import async_playwright
from playwright_stealth import stealth_async


async def check():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ],
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            locale="en-US",
        )
        page = await context.new_page()
        await stealth_async(page)

        print("Loading page with stealth mode...")
        await page.goto(
            "https://vedabase.io/en/library/bg/1/advanced-view/",
            wait_until="domcontentloaded",
            timeout=60000,
        )

        # Wait longer for Cloudflare challenge to auto-resolve
        print("Waiting for Cloudflare to pass...")
        for i in range(30):
            await asyncio.sleep(2)
            title = await page.title()
            body = await page.evaluate("() => document.body.innerText.substring(0, 200)")
            if "security" not in body.lower() and "verif" not in body.lower():
                print(f"  Cloudflare passed after {(i+1)*2} seconds!")
                break
            if i % 5 == 0:
                print(f"  Still waiting... ({(i+1)*2}s)")
        else:
            print("  Cloudflare did NOT pass after 60 seconds.")
            content = await page.content()
            print(content[:1000])
            await browser.close()
            return

        # Now check if we got real content
        result = await page.evaluate("""
            () => {
                const h2 = document.querySelector("h2");
                if (!h2) return "NO H2 FOUND";

                const parent = h2.parentElement;
                let out = "H2 parent tag: " + parent.tagName + "\\n";
                out += "H2 parent class: " + parent.className + "\\n\\n";

                out += "--- ALL CHILDREN OF PARENT (first 60) ---\\n";
                const kids = Array.from(parent.children).slice(0, 60);
                for (const child of kids) {
                    const text = child.innerText || "";
                    const preview = text.substring(0, 80).replace(/\\n/g, " ");
                    out += child.tagName + " class='" + child.className + "' => " + preview + "\\n";
                }

                return out;
            }
        """)

        print(result)
        await browser.close()


asyncio.run(check())