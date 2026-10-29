window.__ModuleLoader__.load({
  id: 'dsh-matlab-feedback',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // Client language pack for this plugin: flat dotted keys, resolved through
    // ctx.locale.bind('matlabFeedback'). Both locales must define every key.
    const dictionaries = {
      zh: {
        'button.label': 'MATLAB 快照',
        'button.title': '抓取当前 MATLAB 窗口截图和命令行窗口，填入输入框',
        'insert.prompt':
          '请调用 matlab_snapshot 抓取当前 MATLAB 的窗口截图和命令行窗口，概述你看到的界面状态（若在 DPARSF QC 流程，说明 QC 界面的关键信息），然后回答我的问题：',
      },
      en: {
        'button.label': 'MATLAB snapshot',
        'button.title': 'Capture MATLAB windows and command window into the draft',
        'insert.prompt':
          'Call matlab_snapshot to capture the current MATLAB window screenshots and command-window text, summarize the interface state you see (if you are in the DPARSF QC workflow, describe the key information on the QC window), then answer my question: ',
      },
    };

    // Original viewfinder/camera glyph, 14px rendered from a 16-unit viewBox.
    // Strokes inherit the button text color, so light/dark themes need no assets.
    function CaptureIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block', flexShrink: 0, pointerEvents: 'none' },
        },
        h('path', {
          d: 'M2.2 5.6h2.5l1-1.6h4.6l1 1.6h2.5a.9.9 0 0 1 .9.9v6.1a.9.9 0 0 1-.9.9H2.2a.9.9 0 0 1-.9-.9V6.5a.9.9 0 0 1 .9-.9Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('circle', {
          cx: 8,
          cy: 9.1,
          r: 2.4,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Locale dictionaries and the slot occupant both follow the plugin lifetime:
        // ctx.effect/ctx.slots.inject dispose them when the plugin unloads.
        ctx.effect(() => ctx.locale.register('matlabFeedback', dictionaries));
        const t = ctx.locale.bind('matlabFeedback');

        function CaptureButton(props) {
          const [hovered, setHovered] = React.useState(false);
          const [focused, setFocused] = React.useState(false);
          const label = t('button.label');
          const title = t('button.title');
          const onClick = () => {
            const inputActions = props && props.inputActions;
            if (!inputActions) return;
            try {
              // Capture the draft selection + revision, then insert the preset prompt
              // as one undoable edit. insertText returns false when the draft changed
              // or the composer is busy; that rejection stays silent by contract.
              // This never submits the message on its own.
              const span = inputActions.captureInsertion();
              inputActions.insertText(t('insert.prompt'), span);
            } catch (error) {
              // A composer-level failure must not bubble out of this decorative button.
            }
          };
          return h(
            'button',
            {
              type: 'button',
              title,
              'aria-label': title,
              onClick,
              onMouseEnter: () => setHovered(true),
              onMouseLeave: () => setHovered(false),
              onFocus: () => setFocused(true),
              onBlur: () => setFocused(false),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                height: 28,
                padding: '0 8px',
                margin: 0,
                flexShrink: 0,
                font: 'inherit',
                fontSize: 12,
                lineHeight: '20px',
                whiteSpace: 'nowrap',
                color: 'var(--dsw-alias-label-primary)',
                background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 6,
                boxShadow: focused ? '0 0 0 1px var(--dsw-alias-brand-primary)' : 'none',
                outline: 'none',
                cursor: 'pointer',
                userSelect: 'none',
                WebkitTapHighlightColor: 'transparent',
                transition: 'background-color 120ms ease, border-color 120ms ease',
              },
            },
            h(CaptureIcon),
            h('span', null, label),
          );
        }

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'matlab-feedback-capture',
              order: 20,
              label: () => t('button.label'),
            },
            CaptureButton,
          ),
        );
      },
    };
  },
});
