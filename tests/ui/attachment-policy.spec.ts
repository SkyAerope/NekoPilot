import { expect, test } from "@playwright/test";
import {
  AttachmentError,
  attachmentFormat,
  attachmentLimits,
  parseAttachments,
  validateAttachmentFiles,
} from "../../src/shared/attachments";

test("空 MIME 文件按扩展名识别支持的格式", () => {
  // Given / When
  const format = attachmentFormat("NOTES.MD");
  // Then
  expect(format).toEqual({ kind: "text", mime: "text/markdown" });
});

for (const [name, size, code] of [
  ["notes.txt", 0, "empty_file"],
  ["notes.txt", attachmentLimits.text + 1, "file_too_large"],
  ["photo.png", attachmentLimits.image + 1, "file_too_large"],
  ["report.pdf", 4, "unsupported_type"],
] as const) {
  test(`拒绝不合法文件 ${name}/${size}`, () => {
    // Given
    const files = [{ name, size }];
    // When / Then
    expect(() => validateAttachmentFiles(files)).toThrow(AttachmentError);
    try {
      validateAttachmentFiles(files);
    } catch (error: unknown) {
      if (!(error instanceof AttachmentError)) throw error;
      expect(error.code).toBe(code);
    }
  });
}

test("最大文件边界允许但第五个附件拒绝", () => {
  // Given
  const file = { name: "notes.txt", size: attachmentLimits.text };
  // When / Then
  expect(() => validateAttachmentFiles([file])).not.toThrow();
  expect(() =>
    validateAttachmentFiles(Array.from({ length: 5 }, () => file)),
  ).toThrow(AttachmentError);
});

test("跨上下文附件引用必须与格式和内容地址一致", () => {
  // Given
  const descriptor = {
    kind: "text",
    name: "notes.txt",
    asset: { id: `text/plain:${"a".repeat(64)}`, mime: "text/plain", size: 10 },
  };
  // When / Then
  expect(parseAttachments([descriptor])).toEqual([descriptor]);
  expect(() => parseAttachments([{ ...descriptor, kind: "image" }])).toThrow(
    AttachmentError,
  );
  expect(() =>
    parseAttachments([
      { ...descriptor, asset: { ...descriptor.asset, id: "forged" } },
    ]),
  ).toThrow(AttachmentError);
});
