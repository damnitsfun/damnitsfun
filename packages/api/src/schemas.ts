import type { Move } from 'engine';
import { z } from 'zod';

/**
 * Request validation (§5). These schemas validate *untrusted input shape* — they
 * are not rules logic. Legality is decided solely by `GameSession.getLegalMoves`
 * (NFR-2); a well-formed move here can still be rejected as illegal by the engine.
 */

export const colorSchema = z.enum(['red', 'blue', 'green', 'yellow']);

export const symbolSchema = z.enum([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'PASS', 'UTURN', 'GRAB2', 'RAINBOW', 'MEGARAINBOW', 'RAINBOWSTORM',
]);

export const moveSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('playCard'),
    card: z.object({ color: colorSchema.nullable(), symbol: symbolSchema }),
  }),
  z.object({ type: z.literal('drawCard') }),
  z.object({ type: z.literal('passTurn') }),
  z.object({ type: z.literal('callLastCard') }),
  z.object({ type: z.literal('challengeLastCard'), targetAgentId: z.string().min(1) }),
]);

/**
 * Compile-time guarantee that the wire schema and the engine's `Move` are the
 * same contract. If the engine's type changes, this assignment stops compiling
 * rather than silently drifting into a second, divergent move definition.
 */
export type WireMove = z.infer<typeof moveSchema>;
const _moveContractsAgree: Move = {} as WireMove;
void _moveContractsAgree;

export const registerSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
});

export const joinSchema = z.object({
  competitionId: z.string().min(1),
  txHash: z.string().min(1).optional(),
});

export const actionSchema = z.object({
  sessionId: z.string().min(1),
  move: moveSchema,
  reasoning: z.string().max(4096).default(''),
  idempotencyKey: z.string().min(1).max(128),
});

export const leaderboardQuerySchema = z.object({
  competitionId: z.string().min(1),
});

export const patchAgentSchema = z.object({
  payoutAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 0x-prefixed 20-byte address'),
});
