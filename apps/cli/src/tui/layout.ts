import {
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  type TUI,
} from '@earendil-works/pi-tui';

import { formatDebugValue } from '../formatting.js';
import {
  bold,
  cyan,
  dim,
  editorTheme,
  gray,
  green,
  markdownTheme,
  red,
  yellow,
} from './theme.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TuiLayout {
  tui: TUI;
  terminal: ProcessTerminal;
  header: Text;
  messages: Container;
  editor: Editor;
  /** Update the header line (agent / session info). */
  setHeader(text: string): void;
  /** Append a plain text message (user input, tool events, status lines). */
  addText(text: string): void;
  /** Append a removable status line, useful for transient waiting indicators. */
  addStatusLine(text: string): StatusLineHandle;
  /** Append the standard agent label line. */
  addAgentLabel(): void;
  /** Append a completed assistant response as markdown. */
  addAssistantMessage(text: string, showLabel?: boolean): void;
  /** Show a yes/no approval overlay. Resolves with the user's choice. */
  requestApproval(toolName: string, args: unknown): Promise<boolean>;
}

export interface StatusLineHandle {
  remove(): void;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export const createTuiLayout = (): TuiLayout => {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  // Header row
  const header = new Text('', 1, 0);
  tui.addChild(header);

  // Thin separator
  const separator = new Text(gray('─'.repeat(60)), 0, 0);
  tui.addChild(separator);

  // Scrolling message history
  const messages = new Container();
  tui.addChild(messages);

  // Input area
  const footer = new Container();
  tui.addChild(footer);

  // Input editor
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  footer.addChild(editor);
  tui.setFocus(editor);

  // ── helpers ──────────────────────────────────────────────────────────────

  const setHeader = (text: string): void => {
    header.setText(text);
    tui.requestRender();
  };

  const addText = (text: string): void => {
    messages.addChild(new Text(text, 1, 0));
    tui.requestRender();
  };

  const addStatusLine = (text: string): StatusLineHandle => {
    const line = new Text(text, 1, 0);
    messages.addChild(line);
    tui.requestRender();

    return {
      remove(): void {
        messages.removeChild(line);
        tui.requestRender();
      },
    };
  };

  const addAgentLabel = (): void => {
    messages.addChild(new Text(`${bold(cyan('agent'))}> `, 1, 0));
    tui.requestRender();
  };

  const addAssistantMessage = (text: string, showLabel = true): void => {
    if (showLabel) {
      addAgentLabel();
    }

    const md = new Markdown(text, 1, 0, markdownTheme);
    messages.addChild(md);
    tui.requestRender();
  };

  const requestApproval = (toolName: string, args: unknown): Promise<boolean> => {
    return new Promise((resolve) => {
      const formatted = formatDebugValue(args);
      const dialog = new Text('', 1, 0);
      let selectedIndex = 0;
      const previousDisableSubmit = editor.disableSubmit;
      editor.disableSubmit = true;

      const renderDialog = () => {
        const approveLine =
          selectedIndex === 0 ? `${cyan('→')} ${green('✓ Approve')}` : `  ${green('✓ Approve')}`;
        const denyLine =
          selectedIndex === 1 ? `${cyan('→')} ${red('✗ Deny')}` : `  ${red('✗ Deny')}`;
        const parts = [
          `Allow ${bold(yellow(toolName))}?`,
          ...(formatted ? [gray(formatted)] : []),
          approveLine,
          denyLine,
          gray('Use ↑/↓ to choose, Enter to confirm, Esc to deny'),
        ];
        dialog.setText(parts.join('\n'));
      };

      renderDialog();
      messages.addChild(dialog);
      tui.requestRender();

      const finish = (approved: boolean): void => {
        removeApprovalListener();
        messages.removeChild(dialog);
        editor.disableSubmit = previousDisableSubmit;
        tui.setFocus(editor);
        tui.requestRender();
        resolve(approved);
      };

      const removeApprovalListener = tui.addInputListener((data) => {
        if (data === '\u001b[A') {
          selectedIndex = 0;
          renderDialog();
          tui.requestRender();
          return { consume: true };
        }

        if (data === '\u001b[B') {
          selectedIndex = 1;
          renderDialog();
          tui.requestRender();
          return { consume: true };
        }

        if (data === 'y' || data === 'Y') {
          finish(true);
          return { consume: true };
        }

        if (data === 'n' || data === 'N') {
          finish(false);
          return { consume: true };
        }

        if (data === '\r' || data === '\n') {
          finish(selectedIndex === 0);
          return { consume: true };
        }

        if (data === '\u001b') {
          finish(false);
          return { consume: true };
        }

        return { consume: true };
      });
    });
  };

  return {
    tui,
    terminal,
    header,
    messages,
    editor,
    setHeader,
    addText,
    addStatusLine,
    addAgentLabel,
    addAssistantMessage,
    requestApproval,
  };
};
