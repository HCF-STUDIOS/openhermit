import type { AgentLocalClient } from '@openhermit/sdk';
import process from 'node:process';
import { Key, matchesKey } from '@earendil-works/pi-tui';

import { HELP_TEXT, OPENHERMIT_ASCII_ART } from '../constants.js';
import {
  formatDebugValue,
  formatSessionList,
} from '../formatting.js';
import { parseSlashCommand } from '../commands.js';
import {
  createCliSessionSpec,
  createSessionId,
  findCliSession,
  listCliSessions,
} from '../sessions.js';
import { streamAssistantTurn } from '../sse.js';
import type { StartupSessionSelection } from '../types.js';
import { renderSessionHistory } from './history.js';
import { createTuiLayout } from './layout.js';
import { bold, cyan, dim, gray, green, red, yellow } from './theme.js';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface TuiChatLoopOptions {
  client: AgentLocalClient;
  token: string;
  agentId: string;
  workspaceRoot: string;
  startupSession: StartupSessionSelection;
  resumeFlag?: boolean | undefined;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export const runTuiChatLoop = async (opts: TuiChatLoopOptions): Promise<void> => {
  const { client, agentId, workspaceRoot, startupSession, resumeFlag } = opts;

  const layout = createTuiLayout();
  const {
    tui,
    editor,
    setHeader,
    addText,
    addStatusLine,
    addAgentLabel,
    addAssistantMessage,
    requestApproval,
  } = layout;

  let currentSessionId = startupSession.sessionId;
  const knownEventIds = new Map<string, number>();
  knownEventIds.set(currentSessionId, startupSession.lastEventId);

  // ── header ────────────────────────────────────────────────────────────────

  const updateHeader = (): void => {
    setHeader(
      `${bold(cyan('agent'))} ${agentId}  ${gray('│')}  ${bold('session')} ${dim(currentSessionId)}`,
    );
  };
  updateHeader();

  // ── startup messages ──────────────────────────────────────────────────────

  if (resumeFlag && startupSession.resumed) {
    addText(gray('[session] Resumed most recent CLI session'));
  }
  addText(cyan(OPENHERMIT_ASCII_ART));
  addText(gray('Workspace: ' + workspaceRoot));
  addText(gray('Type /help for commands. /exit or double Ctrl-C to exit.\n'));

  // ── open initial session ──────────────────────────────────────────────────

  await client.openSession(createCliSessionSpec(currentSessionId));

  if (startupSession.resumed) {
    try {
      const history = await client.listSessionMessages(currentSessionId);
      renderSessionHistory(layout, history);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      addText(`${red('[history]')} failed to load past messages: ${message}`);
    }
  }

  // ── start TUI ─────────────────────────────────────────────────────────────

  tui.start();
  tui.requestRender();

  // ── exit signal ───────────────────────────────────────────────────────────

  let triggerExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    triggerExit = resolve;
  });

  // Abort controller for the in-flight assistant turn (if any),
  // so Ctrl-C can cancel long-running waits.
  let currentTurnAbort: AbortController | null = null;
  let sigintHandler: ((signal: NodeJS.Signals) => void) | null = null;

  const handleInterrupt = (): void => {
    if (currentTurnAbort) {
      if (!currentTurnAbort.signal.aborted) {
        currentTurnAbort.abort();
        addText(gray('[cancelled current turn]'));
        tui.requestRender();
        return;
      }

      triggerExit();
      return;
    }

    triggerExit();
  };

  const removeInputListener = tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl('c'))) {
      handleInterrupt();
      return { consume: true };
    }

    if (matchesKey(data, Key.ctrl('d'))) {
      triggerExit();
      return { consume: true };
    }

    return undefined;
  });

  const handleSigint = (): void => {
    if (currentTurnAbort && !currentTurnAbort.signal.aborted) {
      currentTurnAbort.abort();
      addText(gray('[cancelled current turn]'));
      tui.requestRender();
      return;
    }
    triggerExit();
  };

  // Use process-level SIGINT so Ctrl-C always works, regardless of how
  // the terminal library encodes it.
  sigintHandler = () => {
    handleSigint();
  };
  process.on('SIGINT', sigintHandler);

  // ── input handling ────────────────────────────────────────────────────────

  editor.onSubmit = (text: string): void => {
    const input = text.trim();
    if (!input) return;

    editor.disableSubmit = true;
    editor.addToHistory(text);
    editor.setText('');

    handleInput(input)
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === 'Assistant turn cancelled.') {
          // Silent cancel on Ctrl-C/Ctrl-D; don't show as an error.
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        addText(`${red('[error]')} ${message}`);
      })
      .finally(() => {
        editor.disableSubmit = false;
        tui.requestRender();
      });
  };

  const handleInput = async (input: string): Promise<void> => {
    // ── slash commands ────────────────────────────────────────────────────
    let command;
    try {
      command = parseSlashCommand(input);
    } catch (err: unknown) {
      addText(red((err instanceof Error ? err.message : String(err))));
      return;
    }

    if (command) {
      if (command.type === 'exit') {
        if (currentTurnAbort && !currentTurnAbort.signal.aborted) {
          currentTurnAbort.abort();
        }
        triggerExit();
        return;
      }

      if (command.type === 'help') {
        addText(HELP_TEXT);
        return;
      }

      if (command.type === 'new') {
        await client.checkpointSession(currentSessionId, {
          reason: 'new_session',
        });
        currentSessionId = createSessionId();
        await client.openSession(createCliSessionSpec(currentSessionId));
        knownEventIds.set(currentSessionId, 0);
        updateHeader();
        addText(gray(`[session] Switched to ${currentSessionId}`));
        return;
      }

      if (command.type === 'sessions') {
        const sessions = await listCliSessions(client);
        addText(formatSessionList(sessions, currentSessionId));
        return;
      }

      if (command.type === 'resume') {
        const existing = await findCliSession(client, command.sessionId);
        if (!existing) {
          addText(`${red('[error]')} CLI session not found: ${command.sessionId}`);
          return;
        }
        currentSessionId = existing.sessionId;
        await client.openSession(createCliSessionSpec(currentSessionId));
        knownEventIds.set(
          currentSessionId,
          Math.max(knownEventIds.get(currentSessionId) ?? 0, existing.lastEventId),
        );
        updateHeader();
        addText(gray(`[session] Resumed ${currentSessionId}`));
        try {
          const history = await client.listSessionMessages(currentSessionId);
          renderSessionHistory(layout, history);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          addText(`${red('[history]')} failed to load past messages: ${message}`);
        }
        return;
      }
    }

    // ── regular message ───────────────────────────────────────────────────
    addText(`${bold(cyan('you'))}> ${input}`);
    addAgentLabel();

    // Create a fresh abort controller for this turn so we can cancel
    // streamAssistantTurn when the user hits Ctrl-C.
    currentTurnAbort = new AbortController();
    let thinkingHandle: ReturnType<typeof addStatusLine> | null = addStatusLine(
      gray('[thinking...]'),
    );
    let agentLabelShown = true;
    const clearThinking = () => {
      if (!thinkingHandle) {
        return;
      }

      thinkingHandle.remove();
      thinkingHandle = null;
    };
    const ensureAgentLabel = () => {
      clearThinking();
      if (agentLabelShown) {
        return;
      }

      addAgentLabel();
      agentLabelShown = true;
    };
    let streamedAssistantText = '';
    let streamedThinkingText = '';
    let thinkingDisplayedAsMessage = false;

    const collapseThinkingToBlock = () => {
      if (!thinkingDisplayedAsMessage || !streamedThinkingText.trim()) return;
      thinkingDisplayedAsMessage = false;
      // The thinking was displayed as a streamed assistant message.
      // We can't un-render it in the TUI, but we add a label to indicate
      // it was reasoning, then the real output follows.
      addText(dim(gray('[thinking]')));
    };

    try {
      await streamAssistantTurn(
        client,
        currentSessionId,
        { text: input },
        {
          signal: currentTurnAbort.signal,
          onApprovalRequired: async (toolName, _toolCallId, args) => {
            ensureAgentLabel();
            const approved = await requestApproval(toolName, args);
            addText(approved ? green('[approved]') : red('[denied]'));
            return approved;
          },
          output: {
            onThinkingDelta: (delta) => {
              clearThinking();
              ensureAgentLabel();
              streamedThinkingText += delta;
              thinkingDisplayedAsMessage = true;
            },
            onThinkingFinal: (_fullText) => {
              // Keep displayed as message — will be collapsed if something follows.
            },
            onTextDelta: (delta) => {
              collapseThinkingToBlock();
              clearThinking();
              streamedAssistantText += delta;
            },
            onTextFinal: (fullText, sawDelta) => {
              // If thinking was the final answer (promoted), it's already displayed.
              if (thinkingDisplayedAsMessage && !sawDelta && !fullText.trim()) {
                thinkingDisplayedAsMessage = false;
                streamedThinkingText = '';
                return;
              }

              if (thinkingDisplayedAsMessage && !sawDelta) {
                // text_final with promoted thinking — already shown as message,
                // just render the final markdown version.
                thinkingDisplayedAsMessage = false;
                const text = fullText.trim();
                if (text) {
                  addAssistantMessage(text, false);
                }
                streamedThinkingText = '';
                streamedAssistantText = '';
                return;
              }

              collapseThinkingToBlock();
              clearThinking();
              const text = (sawDelta ? streamedAssistantText : fullText).trim();

              if (text.trim()) {
                ensureAgentLabel();
                addAssistantMessage(text, false);
                agentLabelShown = true;
              }

              streamedAssistantText = '';
              streamedThinkingText = '';
            },
            onToolCall: (tool, args) => {
              collapseThinkingToBlock();
              ensureAgentLabel();
              const formatted = formatDebugValue(args);
              const suffix = formatted
                ? formatted.includes('\n')
                  ? `\n${gray(formatted)}`
                  : ` ${gray(formatted)}`
                : '';
              addText(`${gray('[tool]')} ${yellow(tool)}${suffix}`);
            },
            onToolResult: (_tool, isError) => {
              if (isError) {
                ensureAgentLabel();
                addText(`${red('[tool error]')} ${yellow(_tool)}`);
              }
            },
            onApprovalPrompt: (toolName, args) => {
              collapseThinkingToBlock();
              ensureAgentLabel();
              const formatted = formatDebugValue(args);
              const suffix = formatted ? ` ${gray(formatted)}` : '';
              addText(`${yellow('[approval required]')} ${bold(toolName)}${suffix}`);
            },
            onError: (message) => {
              collapseThinkingToBlock();
              ensureAgentLabel();
              addText(`${red('[error]')} ${message}`);
            },
          },
        },
      );
    } finally {
      if (thinkingHandle) {
        thinkingHandle.remove();
      }
      currentTurnAbort = null;
    }
  };

  // ── wait for exit ─────────────────────────────────────────────────────────
  await exitPromise;

  if (sigintHandler) {
    process.off('SIGINT', sigintHandler);
  }
  removeInputListener();

  await layout.terminal.drainInput().catch(() => undefined);
  tui.stop();
};
