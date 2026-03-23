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

        print("Loading page...")
        await page.goto(
            "https://vedabase.io/en/library/bg/1/advanced-view/",
            wait_until="domcontentloaded",
            timeout=60000,
        )

        print("Waiting for Cloudflare...")
        for i in range(30):
            await asyncio.sleep(2)
            body = await page.evaluate("() => document.body.innerText.substring(0, 300)")
            if "TEXT 1" in body or "dharma" in body.lower():
                print(f"  Passed after {(i+1)*2}s")
                break
        else:
            print("  BLOCKED")
            await browser.close()
            return

        await asyncio.sleep(3)

        result = await page.evaluate("""
            () => {
                let out = "";

                // Count key elements
                const h2s = document.querySelectorAll("h2");
                const avd = document.querySelectorAll(".av-devanagari");
                const avv = document.querySelectorAll(".av-verse_text");
                const avs = document.querySelectorAll(".av-synonyms");
                const avt = document.querySelectorAll(".av-translation");
                const avp = document.querySelectorAll(".av-purport");
                const avvs = document.querySelectorAll(".av-verses");

                out += "=== ELEMENT COUNTS ===\\n";
                out += "h2: " + h2s.length + "\\n";
                out += ".av-devanagari: " + avd.length + "\\n";
                out += ".av-verse_text: " + avv.length + "\\n";
                out += ".av-synonyms: " + avs.length + "\\n";
                out += ".av-translation: " + avt.length + "\\n";
                out += ".av-purport: " + avp.length + "\\n";
                out += ".av-verses: " + avvs.length + "\\n\\n";

                // Show first h2 and everything after it until next h2
                const firstH2 = h2s[0];
                if (firstH2) {
                    out += "=== FIRST H2 AND ITS SIBLINGS ===\\n";
                    out += "H2: " + firstH2.outerHTML.substring(0, 200) + "\\n\\n";

                    let el = firstH2.nextElementSibling;
                    let count = 0;
                    while (el && count < 15) {
                        const tag = el.tagName;
                        const cls = el.className || "(no class)";
                        const txt = (el.innerText || "").substring(0, 100).replace(/\\n/g, " ");
                        out += "  " + tag + " [" + cls + "] => " + txt + "\\n";
                        if (el.children.length > 0 && el.children.length < 10) {
                            for (const kid of el.children) {
                                const ktxt = (kid.innerText || "").substring(0, 80).replace(/\\n/g, " ");
                                out += "    child: " + kid.tagName + " [" + (kid.className || "") + "] => " + ktxt + "\\n";
                            }
                        }
                        el = el.nextElementSibling;
                        count++;
                    }
                }

                return out;
            }
        """)

        print(result)
        await browser.close()


asyncio.run(check())