/** A minimal, dependency-free stand-in for the DSH Host runtime used by tests. */

import {readFile} from 'node:fs/promises';

/** Read intrinsic PNG dimensions from the IHDR chunk (big-endian). */
export function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return {width: 0, height: 0};
  return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

export async function pngSizeOfFile(filePath) {
  return pngSize(await readFile(filePath));
}

/**
 * Build a fake plugin context exposing `tools.register`, an optional
 * attachments store, an optional systemPrompt service and an optional
 * workingDirectory service — exactly what `index.mjs` touches.
 */
export function createFakeHost({workspaceRoot, attachments = true, systemPrompt = true, workingDirectory = true} = {}) {
  const state = {
    registrations: new Map(),
    registrationOrder: [],
    savedImages: [],
    sections: [],
    disposed: [],
  };
  const store = {
    async saveImage(input) {
      if (!(input?.data instanceof Uint8Array)) throw new Error('fake attachments: saveImage data must be a Uint8Array');
      if (typeof input.mediaType !== 'string' || !input.mediaType) throw new Error('fake attachments: saveImage mediaType is required');
      const dimensions = pngSize(Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength));
      const index = state.savedImages.length + 1;
      const ref = {
        attachmentId: `fake-att-${index}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: dimensions.width,
        height: dimensions.height,
        name: input.name ?? `image-${index}.png`,
      };
      state.savedImages.push({input, ref});
      return ref;
    },
  };
  const ctx = {
    tools: {
      register(definition) {
        state.registrations.set(definition.name, definition);
        state.registrationOrder.push(definition.name);
        return () => {
          state.disposed.push(`tool:${definition.name}`);
        };
      },
    },
    get(name) {
      if (name === 'attachments') return attachments === false ? undefined : store;
      if (name === 'systemPrompt') {
        if (systemPrompt === false) return undefined;
        return {
          section({name: sectionName, order, text}) {
            state.sections.push({name: sectionName, order, text});
            return () => {
              state.disposed.push(`section:${sectionName}`);
            };
          },
        };
      }
      if (name === 'workingDirectory') {
        if (workingDirectory === false) return undefined;
        return {
          async ensure(agent) {
            if (!agent) throw new Error('fake workingDirectory: agent is required');
            return workspaceRoot;
          },
        };
      }
      return undefined;
    },
    logger: {
      info() {},
      warn() {},
      debug() {},
    },
  };
  return {ctx, state, store};
}

/** Minimal tool execution environment matching what index.mjs reads. */
export function fakeExec(agent = {id: 'host-dry-run-agent'}) {
  return {agent, signal: new AbortController().signal};
}
