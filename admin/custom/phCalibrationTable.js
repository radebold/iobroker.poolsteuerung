/* eslint-disable */
// Custom pH calibration history editor for ioBroker JSON Config.
(function () {
    'use strict';

    const REMOTE_NAME = 'PoolCalibrationUI';
    let shareScope;

    function compareVersions(a, b) {
        const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
        const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const da = pa[i] || 0;
            const db = pb[i] || 0;
            if (da < db) return -1;
            if (da > db) return 1;
        }
        return 0;
    }

    async function loadShared(moduleName) {
        const g = globalThis;
        try {
            if (g.__webpack_share_scopes__ && g.__webpack_share_scopes__.default) {
                shareScope = g.__webpack_share_scopes__.default;
            }
        } catch {
            // ignore
        }

        if (shareScope && shareScope[moduleName]) {
            try {
                const versions = Object.keys(shareScope[moduleName] || {}).sort((a, b) => compareVersions(b, a));
                for (const version of versions) {
                    const entry = shareScope[moduleName][version];
                    const factory = entry && typeof entry.get === 'function' ? await entry.get() : null;
                    const module = factory && typeof factory === 'function' ? factory() : factory;
                    if (module) return module;
                }
            } catch {
                // ignore
            }
        }

        if (moduleName === 'react') return g.React;
        return null;
    }

    function detectDark(props) {
        try {
            const mode = props && props.theme && props.theme.palette && props.theme.palette.mode;
            if (mode === 'dark') return true;
            if (mode === 'light') return false;
        } catch {
            // ignore
        }
        try {
            const cls = globalThis.document && globalThis.document.body ? globalThis.document.body.className : '';
            if (/\bdark\b/i.test(String(cls))) return true;
        } catch {
            // ignore
        }
        return false;
    }

    function createEditor(React) {
        return function PoolCalibrationHistoryEditor(props) {
            const context = (props && props.oContext) || {};
            const socket = context.socket || (props && props.socket) || globalThis.socket || globalThis._socket;
            const adapterName = context.adapterName || 'poolsteuerung';
            const instanceNumber = context.instance === undefined || context.instance === null ? 0 : context.instance;
            const instance = `${adapterName}.${instanceNumber}`;
            const isDark = detectDark(props);

            const [rows, setRows] = React.useState([]);
            const [selected, setSelected] = React.useState({});
            const [loading, setLoading] = React.useState(false);
            const [error, setError] = React.useState('');
            const [notice, setNotice] = React.useState('');

            const colors = isDark
                ? {
                      panel: '#202020',
                      header: '#2b2b2b',
                      row: '#242424',
                      rowAlt: '#202020',
                      border: 'rgba(255,255,255,0.13)',
                      text: 'rgba(255,255,255,0.92)',
                      muted: 'rgba(255,255,255,0.67)',
                      buttonDisabled: '#555',
                      danger: '#d32f2f',
                      successBg: 'rgba(46,125,50,0.22)',
                      errorBg: 'rgba(211,47,47,0.22)'
                  }
                : {
                      panel: '#fff',
                      header: '#f2f2f2',
                      row: '#fff',
                      rowAlt: '#fafafa',
                      border: 'rgba(0,0,0,0.14)',
                      text: 'rgba(0,0,0,0.87)',
                      muted: 'rgba(0,0,0,0.60)',
                      buttonDisabled: '#aaa',
                      danger: '#d32f2f',
                      successBg: 'rgba(46,125,50,0.12)',
                      errorBg: 'rgba(211,47,47,0.12)'
                  };

            const sendTo = React.useCallback(
                async (command, message) => {
                    if (!socket || typeof socket.sendTo !== 'function') {
                        throw new Error('Die ioBroker-Verbindung ist nicht verfügbar.');
                    }
                    return socket.sendTo(instance, command, message || {});
                },
                [socket, instance]
            );

            const propsRef = React.useRef(props);
            const contextRef = React.useRef(context);
            propsRef.current = props;
            contextRef.current = context;

            const syncParentData = native => {
                if (!native || typeof native !== 'object') return;
                const currentProps = propsRef.current || {};
                const currentContext = contextRef.current || {};
                const nextData = Object.assign({}, currentProps.data || {}, native);
                try {
                    if (typeof currentProps.onChange === 'function') {
                        currentProps.onChange(nextData, undefined, undefined, false);
                    }
                } catch {
                    try {
                        currentProps.onChange(nextData);
                    } catch {
                        // ignore
                    }
                }
                try {
                    if (typeof currentContext.forceUpdate === 'function') {
                        currentContext.forceUpdate(Object.keys(native), nextData);
                    }
                } catch {
                    // ignore
                }
            };

            const loadRows = React.useCallback(
                async options => {
                    const opts = options || {};
                    setLoading(true);
                    setError('');
                    if (!opts.preserveNotice) setNotice('');
                    try {
                        const response = await sendTo('phCalibrationAdminLoad', {});
                        if (!response) throw new Error('Der Adapter hat keine Antwort geliefert.');
                        if (response.error) throw new Error(response.message || String(response.error));
                        const native = response.native && typeof response.native === 'object' ? response.native : {};
                        const nextRows = Array.isArray(native._calHistory) ? native._calHistory : [];
                        setRows(nextRows);
                        setSelected({});
                        if (opts.syncParent) syncParentData(native);
                    } catch (e) {
                        setError(e && e.message ? e.message : String(e));
                    } finally {
                        setLoading(false);
                    }
                },
                [sendTo]
            );

            React.useEffect(() => {
                loadRows({ preserveNotice: false, syncParent: false });
            }, [loadRows]);

            const selectedCount = rows.reduce((count, row) => count + (selected[String(row.nr)] ? 1 : 0), 0);

            const toggle = nr => {
                const key = String(nr);
                setSelected(current => Object.assign({}, current, { [key]: !current[key] }));
                setError('');
                setNotice('');
            };

            const deleteSelected = async () => {
                if (!selectedCount) {
                    setError('Bitte zuerst mindestens einen Kalibrierpunkt markieren.');
                    return;
                }
                if (selectedCount >= rows.length) {
                    setError('Mindestens ein Kalibrierpunkt muss erhalten bleiben.');
                    return;
                }

                const question = selectedCount === 1
                    ? 'Den markierten Kalibrierpunkt dauerhaft löschen?'
                    : `${selectedCount} markierte Kalibrierpunkte dauerhaft löschen?`;
                if (globalThis.confirm && !globalThis.confirm(question)) return;

                setLoading(true);
                setError('');
                setNotice('');
                try {
                    const payloadRows = rows.map(row => Object.assign({}, row, {
                        selected: !!selected[String(row.nr)]
                    }));
                    const response = await sendTo('phCalibrationAdminDeleteSelected', { rows: payloadRows });
                    if (!response) throw new Error('Der Adapter hat keine Antwort geliefert.');
                    if (response.error) throw new Error(response.message || String(response.error));
                    setNotice(response.message || `${selectedCount} Kalibrierpunkt${selectedCount === 1 ? '' : 'e'} gelöscht.`);
                    await loadRows({ preserveNotice: true, syncParent: true });
                } catch (e) {
                    setError(e && e.message ? e.message : String(e));
                    setLoading(false);
                }
            };

            const thStyle = {
                textAlign: 'left',
                padding: '10px 9px',
                fontSize: 12,
                fontWeight: 700,
                color: colors.muted,
                borderBottom: `1px solid ${colors.border}`,
                whiteSpace: 'nowrap'
            };
            const tdStyle = {
                padding: '9px',
                fontSize: 13,
                color: colors.text,
                borderBottom: `1px solid ${colors.border}`,
                whiteSpace: 'nowrap'
            };
            const buttonStyle = {
                border: 0,
                borderRadius: 4,
                padding: '9px 16px',
                fontSize: 13,
                fontWeight: 700,
                cursor: loading || !selectedCount ? 'default' : 'pointer',
                color: '#fff',
                background: loading || !selectedCount ? colors.buttonDisabled : colors.danger,
                opacity: loading ? 0.75 : 1
            };
            const secondaryButtonStyle = {
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                padding: '8px 14px',
                fontSize: 13,
                cursor: loading ? 'default' : 'pointer',
                color: colors.text,
                background: 'transparent'
            };

            return React.createElement(
                'div',
                {
                    style: {
                        width: '100%',
                        background: colors.panel,
                        border: `1px solid ${colors.border}`,
                        borderRadius: 5,
                        overflow: 'hidden',
                        color: colors.text
                    }
                },
                React.createElement(
                    'div',
                    {
                        style: {
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 12,
                            padding: '12px 14px',
                            background: colors.header,
                            borderBottom: `1px solid ${colors.border}`,
                            flexWrap: 'wrap'
                        }
                    },
                    React.createElement(
                        'div',
                        null,
                        React.createElement('div', { style: { fontSize: 17, fontWeight: 700 } }, 'PoolLab-Messungen'),
                        React.createElement(
                            'div',
                            { style: { marginTop: 3, fontSize: 12, color: colors.muted } },
                            'Messpunkte links markieren und anschließend löschen. Median, Streuung und Empfehlung werden automatisch neu berechnet.'
                        )
                    ),
                    React.createElement(
                        'button',
                        { type: 'button', style: secondaryButtonStyle, disabled: loading, onClick: () => loadRows({ preserveNotice: false, syncParent: true }) },
                        loading ? 'Lädt …' : 'Aktualisieren'
                    )
                ),
                error
                    ? React.createElement('div', { style: { padding: '10px 14px', background: colors.errorBg, color: colors.text, fontWeight: 600 } }, `Fehler: ${error}`)
                    : null,
                notice
                    ? React.createElement('div', { style: { padding: '10px 14px', background: colors.successBg, color: colors.text, fontWeight: 600 } }, notice)
                    : null,
                React.createElement(
                    'div',
                    { style: { width: '100%', overflowX: 'auto' } },
                    React.createElement(
                        'table',
                        { style: { width: '100%', minWidth: 980, borderCollapse: 'collapse' } },
                        React.createElement(
                            'thead',
                            null,
                            React.createElement(
                                'tr',
                                { style: { background: colors.header } },
                                React.createElement('th', { style: Object.assign({}, thStyle, { width: 72 }) }, 'Löschen'),
                                React.createElement('th', { style: Object.assign({}, thStyle, { width: 48 }) }, 'Nr.'),
                                React.createElement('th', { style: thStyle }, 'Datum / Uhrzeit'),
                                React.createElement('th', { style: thStyle }, 'PH803W roh'),
                                React.createElement('th', { style: thStyle }, 'PoolLab'),
                                React.createElement('th', { style: thStyle }, 'Korrektur'),
                                React.createElement('th', { style: thStyle }, 'Abstand Median'),
                                React.createElement('th', { style: thStyle }, 'Bewertung')
                            )
                        ),
                        React.createElement(
                            'tbody',
                            null,
                            rows.length
                                ? rows.map((row, index) =>
                                      React.createElement(
                                          'tr',
                                          { key: `${row.nr}-${row.date}-${row.raw}-${row.ref}`, style: { background: index % 2 ? colors.rowAlt : colors.row } },
                                          React.createElement(
                                              'td',
                                              { style: tdStyle },
                                              React.createElement('input', {
                                                  type: 'checkbox',
                                                  checked: !!selected[String(row.nr)],
                                                  onChange: () => toggle(row.nr),
                                                  'aria-label': `Kalibrierpunkt ${row.nr} zum Löschen markieren`,
                                                  style: { width: 18, height: 18, cursor: 'pointer' }
                                              })
                                          ),
                                          React.createElement('td', { style: tdStyle }, row.nr),
                                          React.createElement('td', { style: tdStyle }, row.date || '--'),
                                          React.createElement('td', { style: tdStyle }, row.raw || '--'),
                                          React.createElement('td', { style: tdStyle }, row.ref || '--'),
                                          React.createElement('td', { style: tdStyle }, row.delta || '--'),
                                          React.createElement('td', { style: tdStyle }, row.distance || '--'),
                                          React.createElement('td', { style: tdStyle }, row.status || 'Historie')
                                      )
                                  )
                                : React.createElement(
                                      'tr',
                                      null,
                                      React.createElement(
                                          'td',
                                          { colSpan: 8, style: Object.assign({}, tdStyle, { padding: 18, textAlign: 'center', color: colors.muted }) },
                                          loading ? 'Kalibrierhistorie wird geladen …' : 'Keine Kalibrierpunkte vorhanden.'
                                      )
                                  )
                        )
                    )
                ),
                React.createElement(
                    'div',
                    {
                        style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            padding: '12px 14px',
                            background: colors.header,
                            flexWrap: 'wrap'
                        }
                    },
                    React.createElement(
                        'button',
                        {
                            type: 'button',
                            style: buttonStyle,
                            disabled: loading || !selectedCount,
                            onClick: deleteSelected
                        },
                        selectedCount ? `Löschen (${selectedCount})` : 'Löschen'
                    ),
                    React.createElement(
                        'span',
                        { style: { fontSize: 12, color: colors.muted } },
                        selectedCount
                            ? `${selectedCount} von ${rows.length} Messpunkten markiert`
                            : `Es sind ${rows.length} Messpunkte vorhanden.`
                    )
                )
            );
        };
    }

    function register(React) {
        if (!React) return null;
        const component = createEditor(React);
        globalThis.customComponents = globalThis.customComponents || {};
        globalThis.customComponents.PoolCalibrationHistoryEditor = component;
        return component;
    }

    try {
        register(globalThis.React);
    } catch {
        // ignore; module federation path below will retry
    }

    const moduleMap = {
        './Components': async function () {
            const React = globalThis.React || (await loadShared('react'));
            if (!React) throw new Error('PoolCalibration custom UI: React not available.');
            const PoolCalibrationHistoryEditor = register(React);
            return { default: { PoolCalibrationHistoryEditor } };
        },
        'Components': async function () {
            return moduleMap['./Components']();
        }
    };

    function get(module) {
        const factory = moduleMap[module];
        if (!factory) return Promise.reject(new Error(`Module ${module} not found in ${REMOTE_NAME}`));
        return Promise.resolve(factory()).then(exports => () => exports);
    }

    function init(scope) {
        shareScope = scope;
        return Promise.resolve();
    }

    globalThis[REMOTE_NAME] = { get, init };
})();
