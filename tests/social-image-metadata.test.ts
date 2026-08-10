/** Contracts for the owner-selected social preview image and its metadata. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const layoutSource = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8");
const socialImage = join(
  process.cwd(),
  "public/images/ChatGPT Image Aug 10, 2026, 05_51_20 AM.png",
);
const retiredImage = join(process.cwd(), "public/images/og-image.png");

describe("social preview image metadata", () => {
  it("uses the encoded path in Open Graph, Twitter, and JSON-LD", () => {
    const openGraphBlock = layoutSource.slice(
      layoutSource.indexOf("openGraph:"),
      layoutSource.indexOf("twitter:"),
    );
    const twitterBlock = layoutSource.slice(
      layoutSource.indexOf("twitter:"),
      layoutSource.indexOf("robots:"),
    );
    const structuredDataBlock = layoutSource.slice(
      layoutSource.indexOf("Structured data:"),
    );

    expect(layoutSource).toContain(
      '"/images/ChatGPT%20Image%20Aug%2010%2C%202026%2C%2005_51_20%20AM.png"',
    );
    expect(openGraphBlock).toContain("url: SOCIAL_IMAGE_PATH");
    expect(twitterBlock).toContain("url: SOCIAL_IMAGE_PATH");
    expect(structuredDataBlock).toContain(
      "logo: new URL(SOCIAL_IMAGE_PATH, SITE_URL).toString()",
    );
    expect(layoutSource).not.toContain("og-image.png");
  });

  it("fully decodes the replacement and declares its real dimensions", async () => {
    expect(existsSync(socialImage)).toBe(true);
    const { info } = await sharp(socialImage).toBuffer({ resolveWithObject: true });
    expect(info.format).toBe("png");
    expect(info.width).toBe(1672);
    expect(info.height).toBe(941);
    expect(layoutSource).toContain("const SOCIAL_IMAGE_WIDTH = 1672");
    expect(layoutSource).toContain("const SOCIAL_IMAGE_HEIGHT = 941");
    expect(layoutSource).toContain(
      'const SOCIAL_IMAGE_ALT = "Ask Śrīla Prabhupāda — Books, Lectures, and Letters"',
    );
  });

  it("removes the retired social card", () => {
    expect(existsSync(retiredImage)).toBe(false);
  });
});
