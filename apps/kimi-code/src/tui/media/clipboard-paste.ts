/**
 * Clipboard image/video paste: the shared clipboard → decode → compress →
 * `ImageAttachmentStore` → placeholder-insertion pipeline behind Ctrl-V (see
 * `CustomEditor.handleInput`'s `onPasteImage` binding).
 *
 * One implementation, two call sites: the main REPL editor
 * (`EditorKeyboardController`) and the agents-view dispatch composer
 * (`AgentsViewController`) both wire `CustomEditor.onPasteImage` to this
 * function — they differ only in which editor/harness/session they paste
 * into and how a failure gets reported (`deps.notifyError`), never in the
 * paste mechanics themselves.
 */

import { compressImageForModel, persistOriginalImage, sessionMediaOriginalsDir } from '@moonshot-ai/kimi-code-sdk';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import { parseImageMeta } from '#/utils/image/image-mime';

import type { CustomEditor } from '../components/editor/custom-editor';
import type { ImageAttachmentStore } from '../utils/image-attachment-store';

export interface ClipboardPasteDeps {
  /** The composer the placeholder is inserted into. */
  readonly editor: CustomEditor;
  readonly imageStore: ImageAttachmentStore;
  /**
   * Drives paste-time compression via `imageLimits.maxEdgePx()`; a caller
   * without a harness (or an unset `imageLimits`) falls back to the env/
   * built-in default `compressImageForModel` already applies.
   */
  readonly harness?: KimiHarness | undefined;
  /**
   * Known session directory, when one exists yet — the pre-compression
   * original is persisted under its `media-originals` dir when set, else
   * the temp-dir fallback `persistOriginalImage` already applies.
   */
  readonly sessionDir?: string | undefined;
  // Method-shorthand signatures (not arrow-typed fields): TS checks these
  // bivariantly, matching `EditorKeyboardHost`'s own `track`/`showError`
  // declarations — both call sites forward their host's already-compatible
  // method straight through, and an arrow-typed field here would reject
  // that under strict contravariant checking (the host's real `track`
  // narrows `properties` to a telemetry-specific type, not the wide
  // `Record<string, unknown>` this pipeline uses internally).
  track(event: string, properties?: Record<string, unknown>): void;
  /** Reports a clipboard read failure (`ClipboardMediaError`) to the user. */
  notifyError(message: string): void;
  requestRender(): void;
}

/**
 * Handles a Ctrl-V paste: reads the clipboard, and for an image or video,
 * builds an attachment and inserts its `[image|video #N …]` placeholder at
 * the cursor. Returns `true` when the paste was handled (image, video, or a
 * reported clipboard error) so the caller's `onPasteImage` binding knows not
 * to fall back to a plain-text paste; `false` when there was nothing this
 * pipeline recognises (empty clipboard, unparseable image bytes), letting
 * that fallback run.
 */
export async function pasteClipboardImage(deps: ClipboardPasteDeps): Promise<boolean> {
  let media;
  try {
    media = await readClipboardMedia();
  } catch (error) {
    if (error instanceof ClipboardMediaError) {
      deps.notifyError(error.message);
      return true;
    }
    return false;
  }
  if (media === null) return false;

  if (media.kind === 'video') {
    const attachment = deps.imageStore.addVideo(media.mimeType, media.sourcePath, media.filename);
    deps.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    deps.requestRender();
    deps.track('shortcut_paste', { kind: 'video' });
    return true;
  }

  const meta = parseImageMeta(media.bytes);
  if (meta === null) return false;
  // Compress at ingestion — a pure data step while building the attachment, so
  // the stored bytes, the inline thumbnail, the `[image #N (W×H)]` placeholder,
  // and the submitted image all agree, and the agent core only ever sees an
  // already-compressed image. Best effort: originals pass through on failure.
  // When compression changed the bytes, the original is persisted (into the
  // session's media-originals dir when known, else the temp-dir fallback)
  // and recorded on the attachment, so submit-time expansion can announce
  // the compression and point the model at the full-fidelity copy.
  // The edge cap comes from the caller's harness [image] config (resolved per
  // paste so a config reload applies immediately); callers without a harness
  // use the env/built-in default.
  const compressed = await compressImageForModel(media.bytes, meta.mime, {
    maxEdge: deps.harness?.imageLimits?.maxEdgePx(),
    telemetry: {
      client: {
        track: (event, properties) =>
          deps.track(event, properties === undefined ? undefined : { ...properties }),
      },
      source: 'tui_paste',
    },
  });
  // Dimensions come from the compression result, not parseImageMeta: the
  // compressor reports display space (EXIF orientation applied) — the space
  // the sent image, the caption, and ReadMediaFile region readback share —
  // while parseImageMeta reads the raw pre-rotation header.
  const attachment = compressed.changed
    ? deps.imageStore.addImage(
        compressed.data,
        compressed.mimeType,
        compressed.width,
        compressed.height,
        {
          path: await persistOriginalImage(
            media.bytes,
            meta.mime,
            deps.sessionDir === undefined ? {} : { dir: sessionMediaOriginalsDir(deps.sessionDir) },
          ),
          width: compressed.originalWidth,
          height: compressed.originalHeight,
          byteLength: media.bytes.length,
          mime: meta.mime,
        },
      )
    : deps.imageStore.addImage(
        media.bytes,
        meta.mime,
        compressed.width || meta.width,
        compressed.height || meta.height,
      );
  deps.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
  deps.requestRender();
  deps.track('shortcut_paste', { kind: 'image' });
  return true;
}
