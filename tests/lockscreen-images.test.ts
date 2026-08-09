import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { GET as convertLockscreenImage } from "@/app/api/lockscreen-images/heic/route";
import {
  convertLockscreenImageToJpeg,
  detectedIsoBmffImageFormat,
  detectedLockscreenFormat,
  discoverLockscreenImages,
  getLockscreenImageForConversion,
  getLockscreenImagePath,
  getLockscreenPublicImageUrl,
  getLockscreenSlideshowImages,
  lockscreenConversionDigest,
} from "@/app/lib/server/01-lockscreen-images";

const temporaryDirectories: string[] = [];
const realHeicFixture = path.join(process.cwd(), "tests", "fixtures", "rainbow-451x461.heic");

async function makeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lockscreen-images-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function imageBytes(format: "jpeg" | "png" | "avif", width = 9, height = 5): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 108, g: 87, b: 201 },
    },
  });
  if (format === "jpeg") return image.jpeg().toBuffer();
  if (format === "png") return image.png().toBuffer();
  return image.avif().toBuffer();
}

function ftypBytes(majorBrand: string, compatibleBrands: string[] = []): Buffer {
  const bytes = Buffer.alloc(16 + (compatibleBrands.length * 4));
  bytes.writeUInt32BE(bytes.byteLength, 0);
  bytes.write("ftyp", 4, 4, "ascii");
  bytes.write(majorBrand, 8, 4, "ascii");
  for (const [index, brand] of compatibleBrands.entries()) {
    bytes.write(brand, 16 + (index * 4), 4, "ascii");
  }
  return bytes;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("lockscreen image discovery", () => {
  it("keeps the three requested photos and excludes the two requested deletions", async () => {
    const discovered = await discoverLockscreenImages();
    const names = discovered.map((image) => image.fileName);

    expect(names).toEqual(expect.arrayContaining([
      "prabhupadaanddisciplessmiling.jpg",
      "Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg",
      "Srila-Prabhupada-on-morning-walk-in-Vrindavan-620x350.avif",
    ]));
    expect(names).not.toContain("CT03-044-620x350.avif");
    expect(names).not.toContain("Prabh14.jpg");

    const mislabeledDeities = discovered.find((image) => (
      image.fileName === "Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg"
    ));
    expect(mislabeledDeities).toMatchObject({ actualFormat: "avif", requiresConversion: true });
    await expect(getLockscreenPublicImageUrl(mislabeledDeities!.fileName)).resolves.toMatch(
      /^\/api\/lockscreen-images\/heic\?file=Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India\.jpg&v=[a-f0-9]{16}$/,
    );
  });

  it("requires the content version before normalizing a mislabeled file", async () => {
    const fileName = "Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg";
    const generatedUrl = await getLockscreenPublicImageUrl(fileName);
    expect(generatedUrl).not.toBeNull();

    const unversioned = new URL(generatedUrl!, "http://localhost");
    unversioned.searchParams.delete("v");
    expect((await convertLockscreenImage(new NextRequest(unversioned))).status).toBe(400);

    const stale = new URL(generatedUrl!, "http://localhost");
    stale.searchParams.set("v", "0000000000000000");
    expect((await convertLockscreenImage(new NextRequest(stale))).status).toBe(404);

    const response = await convertLockscreenImage(new NextRequest(new URL(generatedUrl!, "http://localhost")));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, s-maxage=31536000, immutable");
    expect(response.headers.get("etag")).toBe(`"${lockscreenConversionDigest(
      (await getLockscreenImageForConversion(fileName))!.sha256,
    )}"`);
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 1200, height: 793 });
  });

  it("automatically reflects added and removed valid files in deterministic filename order", async () => {
    const directory = await makeDirectory();
    await fs.writeFile(path.join(directory, "z-last.jpg"), await imageBytes("jpeg"));
    await fs.writeFile(path.join(directory, ".gitkeep"), "");
    await fs.writeFile(path.join(directory, ".hidden-corrupt.jpg"), "not image bytes");
    await fs.mkdir(path.join(directory, "nested"));
    await fs.writeFile(path.join(directory, "nested", "nested.jpg"), await imageBytes("jpeg"));

    expect((await discoverLockscreenImages(directory)).map((image) => image.fileName)).toEqual(["z-last.jpg"]);

    await fs.writeFile(path.join(directory, "a-first.png"), await imageBytes("png"));
    expect((await discoverLockscreenImages(directory)).map((image) => image.fileName)).toEqual([
      "a-first.png",
      "z-last.jpg",
    ]);

    await fs.rm(path.join(directory, "z-last.jpg"));
    expect((await discoverLockscreenImages(directory)).map((image) => image.fileName)).toEqual(["a-first.png"]);
  });

  it("uses decoded bytes and sends extension mismatches through conversion", async () => {
    const directory = await makeDirectory();
    await fs.writeFile(path.join(directory, "actually-avif.jpg"), await imageBytes("avif"));
    await fs.writeFile(path.join(directory, "ordinary.jpg"), await imageBytes("jpeg"));

    const discovered = await discoverLockscreenImages(directory);
    expect(discovered.map(({ fileName, actualFormat, requiresConversion }) => ({
      fileName,
      actualFormat,
      requiresConversion,
    }))).toEqual([
      { fileName: "actually-avif.jpg", actualFormat: "avif", requiresConversion: true },
      { fileName: "ordinary.jpg", actualFormat: "jpeg", requiresConversion: false },
    ]);

    const slides = await getLockscreenSlideshowImages(directory);
    expect(slides[0].url).toMatch(/^\/api\/lockscreen-images\/heic\?file=actually-avif\.jpg&v=[a-f0-9]{16}$/);
    expect(slides[1].url).toMatch(/^\/images\/lockscreen\/ordinary\.jpg\?v=[a-f0-9]{16}$/);
  });

  it("identifies AVIF and HEIC containers from metadata rather than names", () => {
    expect(detectedLockscreenFormat({ format: "heif", compression: "av1" })).toBe("avif");
    expect(detectedLockscreenFormat({ format: "heif", compression: "hevc" })).toBe("heic");
    expect(detectedLockscreenFormat({ format: "tiff" })).toBeNull();
  });

  it("recognizes compatible-brand HEIC with AVIF precedence", () => {
    expect(detectedIsoBmffImageFormat(ftypBytes("zzzz", ["heic"]))).toBe("heic");
    expect(detectedIsoBmffImageFormat(ftypBytes("heic", ["avif"]))).toBe("avif");
    expect(detectedIsoBmffImageFormat(ftypBytes("mif1", ["avif"]))).toBe("avif");
  });

  it("detects and discovers a real HEVC-compressed HEIC from bytes despite a wrong extension", async () => {
    const heicBytes = await fs.readFile(realHeicFixture);
    const directory = await makeDirectory();
    await fs.writeFile(path.join(directory, "rainbow-mislabeled.jpg"), heicBytes);

    expect(detectedIsoBmffImageFormat(heicBytes)).toBe("heic");
    expect(await discoverLockscreenImages(directory)).toEqual([
      expect.objectContaining({
        fileName: "rainbow-mislabeled.jpg",
        actualFormat: "heic",
        requiresConversion: true,
        width: 451,
        height: 461,
      }),
    ]);
    expect((await getLockscreenSlideshowImages(directory))[0].url).toMatch(
      /^\/api\/lockscreen-images\/heic\?file=rainbow-mislabeled\.jpg&v=[a-f0-9]{16}$/,
    );
  });

  it("converts the real HEIC fixture through RGBA to a same-size JPEG", async () => {
    const heicBytes = await fs.readFile(realHeicFixture);
    const converted = await convertLockscreenImageToJpeg(heicBytes);
    const metadata = await sharp(converted).metadata();

    expect(metadata.format).toBe("jpeg");
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 451, height: 461 });
  });

  it("normalizes an unknown major brand when compatible HEIC bytes are proved", async () => {
    const original = await fs.readFile(realHeicFixture);
    const compatibleOnly = Buffer.from(original);
    compatibleOnly.write("zzzz", 8, 4, "ascii");
    expect(detectedIsoBmffImageFormat(compatibleOnly)).toBe("heic");

    const converted = await convertLockscreenImageToJpeg(compatibleOnly);
    const metadata = await sharp(converted).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 451, height: 461 });
  });

  it("keeps genuine AVIF bytes on the existing Sharp/direct-serving path", async () => {
    const directory = await makeDirectory();
    const avifBytes = await imageBytes("avif", 17, 11);
    await fs.writeFile(path.join(directory, "genuine.avif"), avifBytes);

    expect(detectedIsoBmffImageFormat(avifBytes)).toBe("avif");
    expect(await discoverLockscreenImages(directory)).toEqual([
      expect.objectContaining({
        fileName: "genuine.avif",
        actualFormat: "avif",
        requiresConversion: false,
        width: 17,
        height: 11,
      }),
    ]);
    expect((await getLockscreenSlideshowImages(directory))[0].url).toMatch(
      /^\/images\/lockscreen\/genuine\.avif\?v=[a-f0-9]{16}$/,
    );
  });

  it("fails a corrupt upload with the exact filename", async () => {
    const directory = await makeDirectory();
    await fs.writeFile(path.join(directory, "broken-photo.jpg"), "not image bytes");

    await expect(discoverLockscreenImages(directory)).rejects.toThrow('"broken-photo.jpg"');
  });

  it("fails corrupt HEIC-branded bytes with the exact filename", async () => {
    const directory = await makeDirectory();
    const heicFtypOnly = Buffer.from("000000186674797068656963000000006d69663168656963", "hex");
    await fs.writeFile(path.join(directory, "broken-hevc-photo.jpg"), heicFtypOnly);

    await expect(discoverLockscreenImages(directory)).rejects.toThrow('"broken-hevc-photo.jpg"');
  });

  it("fails a decodable but unsupported format with the exact filename", async () => {
    const directory = await makeDirectory();
    const tiff = await sharp({
      create: { width: 4, height: 3, channels: 3, background: "#ffffff" },
    }).tiff().toBuffer();
    await fs.writeFile(path.join(directory, "unsupported-scan.tiff"), tiff);

    await expect(discoverLockscreenImages(directory)).rejects.toThrow('"unsupported-scan.tiff"');
  });

  it("returns a no-photo fallback for an empty or absent folder", async () => {
    const directory = await makeDirectory();
    const empty = await getLockscreenSlideshowImages(directory);
    const absent = await getLockscreenSlideshowImages(path.join(directory, "missing"));

    expect(empty).toEqual([]);
    expect(absent).toEqual(empty);
  });

  it("rejects traversal and accepts only a direct child filename", async () => {
    const directory = await makeDirectory();
    const validPath = path.join(directory, "valid.jpg");
    await fs.writeFile(validPath, await imageBytes("jpeg"));

    expect(getLockscreenImagePath("valid.jpg", directory)).toBe(validPath);
    expect(getLockscreenImagePath("../valid.jpg", directory)).toBeNull();
    expect(getLockscreenImagePath("subdir/valid.jpg", directory)).toBeNull();
    expect(getLockscreenImagePath("subdir\\valid.jpg", directory)).toBeNull();
    expect(getLockscreenImagePath(path.resolve(validPath), directory)).toBeNull();
    expect(getLockscreenImagePath(".hidden.jpg", directory)).toBeNull();

    const retainedFile = "prabhupadaanddisciplessmiling.jpg";
    const retainedPath = path.join(process.cwd(), "public", "images", "lockscreen", retainedFile);
    const source = await getLockscreenImageForConversion(retainedFile);
    expect(source?.bytes.equals(await fs.readFile(retainedPath))).toBe(true);
    expect(source?.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(getLockscreenImageForConversion("../valid.jpg")).resolves.toBeNull();
  });

  it("normalizes to JPEG without changing pixel dimensions", async () => {
    const source = await imageBytes("avif", 13, 7);
    const converted = await convertLockscreenImageToJpeg(source);
    const metadata = await sharp(converted).metadata();

    expect(metadata.format).toBe("jpeg");
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 13, height: 7 });
  });

  it("honors EXIF orientation during normalization without cropping", async () => {
    const oriented = await sharp({
      create: { width: 13, height: 7, channels: 3, background: "#ffffff" },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const converted = await convertLockscreenImageToJpeg(oriented);
    const metadata = await sharp(converted).metadata();

    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 7, height: 13 });
  });
});
