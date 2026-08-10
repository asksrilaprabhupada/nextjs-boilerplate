/** Contracts for the owner-selected social preview image and its metadata. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const layoutSource = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8");
const sourceImage = join(
  process.cwd(),
  "public/images/ChatGPT Image Aug 10, 2026, 05_51_20 AM.png",
);
const socialImage = join(process.cwd(), "public/images/social-share-v2.jpg");
const retiredImage = join(process.cwd(), "public/images/og-image.png");

describe("social preview image metadata", () => {
  it("uses the simple cache-busting path in Open Graph, Twitter, and JSON-LD", () => {
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

    expect(layoutSource).toContain('"/images/social-share-v2.jpg"');
    expect(openGraphBlock).toContain("url: SOCIAL_IMAGE_PATH");
    expect(openGraphBlock).toContain("type: SOCIAL_IMAGE_TYPE");
    expect(twitterBlock).toContain("url: SOCIAL_IMAGE_PATH");
    expect(twitterBlock).toContain("type: SOCIAL_IMAGE_TYPE");
    expect(structuredDataBlock).toContain(
      "logo: new URL(SOCIAL_IMAGE_PATH, SITE_URL).toString()",
    );
    expect(layoutSource).not.toContain("og-image.png");
  });

  it("fully decodes the WhatsApp-compatible derivative and declares its contract", async () => {
    expect(existsSync(sourceImage)).toBe(true);
    expect(existsSync(socialImage)).toBe(true);
    const sourceBytes = readFileSync(sourceImage);
    const socialBytes = readFileSync(socialImage);
    const metadata = await sharp(socialBytes).metadata();
    const { info } = await sharp(socialBytes).toBuffer({ resolveWithObject: true });

    expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(
      "3dc4e6478085b6ca97e114f697d2105fd7984c1fa016fb4832fe0d5465d227e7",
    );
    expect(createHash("sha256").update(socialBytes).digest("hex")).toBe(
      "11f0614c31c105130bbf2c986eb3db8720a0f461544e388bf047648fe1ebaa90",
    );
    expect(Array.from(socialBytes.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    expect(socialBytes.byteLength).toBeLessThanOrEqual(300 * 1024);
    expect(info.format).toBe("jpeg");
    expect(info.width).toBe(1672);
    expect(info.height).toBe(941);
    expect(metadata.space).toBe("srgb");
    expect(metadata.channels).toBe(3);
    expect(metadata.hasAlpha).toBe(false);
    expect(metadata.isProgressive).toBe(false);
    expect(layoutSource).toContain('const SOCIAL_IMAGE_TYPE = "image/jpeg"');
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
