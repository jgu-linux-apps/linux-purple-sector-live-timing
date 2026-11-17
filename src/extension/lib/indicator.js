// SPDX-License-Identifier: GPL-2.0-or-later
// Panel button: icon (optionally with the top drivers) and the timing menu.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as View from './view.js';
import {versionFromMetadata, isUpdateInstalled} from './version.js';

const MAX_PANEL_ITEMS = 3;

function box(vertical, params = {}) {
    const b = new St.BoxLayout(params);
    if (vertical) {
        // St.BoxLayout:vertical was replaced by :orientation in GNOME 48 and removed in 51
        if ('orientation' in b)
            b.orientation = Clutter.Orientation.VERTICAL;
        else
            b.vertical = true;
    }
    return b;
}

function label(text, styleClass = '', params = {}) {
    return new St.Label({
        text: text ?? '',
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
        ...params,
    });
}

// Write only when the value differs: every St write queues a relayout or a restyle,
// and the shell paints the pointer on the same thread.
function setText(actor, text) {
    text = text == null ? '' : String(text);
    if (actor.text !== text)
        actor.text = text;
}

function setClass(actor, styleClass) {
    if (actor.style_class !== styleClass)
        actor.style_class = styleClass;
}

function setStyle(actor, style) {
    if (actor.style !== style)
        actor.style = style;
}

function setVisible(actor, visible) {
    if (actor.visible !== visible)
        actor.visible = visible;
}

function colourStyle(colour) {
    const c = /^#[0-9a-fA-F]{6}$/.test(colour ?? '') ? colour : '#888888';
    return `background-color: ${c};`;
}

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension, service, settings) {
        super._init(0.0, extension.metadata.name, false);
        this._extension = extension;
        this._service = service;
        this._settings = settings;
        this._iconsDir = extension.dir.get_child('icons');
        this._model = null;
        this._modelKey = '';
        this._renderedKey = '';
        this._layoutKey = '';
        this._ui = null;
        this._newVersion = '';

        this._buildPanel();

        this.menu.actor.add_style_class_name('psl-menu');
        this._root = box(true, {style_class: 'psl-popup'});
        this.menu.box.add_child(this._root);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._checkInstalledVersion();
                this._renderedKey = '';
                this._renderMenu();
            }
        });

        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceSettingsId = this._interfaceSettings.connect('changed::color-scheme',
            () => this.refresh());
        this._settingsId = this._settings.connect('changed', () => this.refresh());
    }

    _buildPanel() {
        this._panelBox = box(false, {style_class: 'psl-panel'});
        this._icon = new St.Icon({style_class: 'system-status-icon psl-panel-icon'});
        this._panelBox.add_child(this._icon);
        this._chip = label('', 'psl-panel-chip', {visible: false});
        this._panelBox.add_child(this._chip);
        this._items = [];
        for (let i = 0; i < MAX_PANEL_ITEMS; i++) {
            const item = box(false, {style_class: 'psl-panel-item', visible: false});
            const widgets = {
                item,
                pos: label('', 'psl-panel-pos'),
                bar: new St.Widget({style_class: 'psl-panel-bar', y_align: Clutter.ActorAlign.CENTER}),
                tla: label('', 'psl-panel-tla'),
                value: label('', 'psl-panel-value'),
                flag: this._flagIcon('psl-panel-flag'),
            };
            item.add_child(widgets.pos);
            item.add_child(widgets.bar);
            item.add_child(widgets.tla);
            item.add_child(widgets.value);
            item.add_child(widgets.flag);
            this._panelBox.add_child(item);
            this._items.push(widgets);
        }
        this._idle = label('', 'psl-panel-idle', {visible: false});
        this._panelBox.add_child(this._idle);
        this.add_child(this._panelBox);
        this._panelBox.connect('style-changed', () => this._updateIcon());
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        this._interfaceSettings.disconnect(this._interfaceSettingsId);
        this._interfaceSettings = null;
        super.destroy();
    }

    // ------------------------------------------------------------- model
    _options() {
        return {
            panelDrivers: this._settings.get_int('panel-drivers'),
            raceMode: this._settings.get_string('race-mode'),
            practiceMode: this._settings.get_string('practice-mode'),
            showPanelStatus: this._settings.get_boolean('show-panel-status'),
            delay: this._settings.get_int('delay-seconds'),
            replay: this._service.replaying,
            idleText: this._idleText(),
        };
    }

    _idleText() {
        const s = this._service;
        if (s.replaying)
            return _('Loading demo…');
        if (s.connection === 'connecting')
            return _('Connecting…');
        if (s.connection === 'connected') {
            const active = s.activeSession();
            if (!active)
                return _('No live session');
            const name = View.sessionLabel(active.code, _);
            return GLib.get_real_time() / 1e6 < active.start
                ? View.sprintf(_('Starting soon: %s'), name)
                : View.sprintf(_('Waiting for data: %s'), name);
        }
        const next = s.nextSession();
        if (!next)
            return '';
        const when = GLib.DateTime.new_from_unix_local(next.start);
        const days = (next.start - GLib.get_real_time() / 1e6) / 86400;
        return View.sprintf(_('Next: %s · %s'), View.sessionLabel(next.code, _),
            when.format(days < 6 ? '%a %H:%M' : '%e %b %H:%M').trim());
    }

    get dark() {
        const theme = this._settings.get_string('theme');
        if (theme === 'light' || theme === 'dark')
            return theme === 'dark';
        return this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
    }

    /** Rebuilds the view model; repaints the panel, and the menu when it is open. */
    refresh() {
        const model = View.build(this._service.displaySnapshot(), this._options(), _);
        model.dark = this.dark;
        model.expanded = this._settings.get_boolean('expanded');
        model.settings = {
            panelDrivers: this._settings.get_int('panel-drivers'),
            raceMode: this._settings.get_string('race-mode'),
            practiceMode: this._settings.get_string('practice-mode'),
        };
        const key = JSON.stringify(model);
        if (key === this._modelKey)
            return;
        this._modelKey = key;
        this._model = model;
        this._renderPanel();
        if (this.menu.isOpen)
            this._renderMenu();
    }

    // ------------------------------------------------------------- panel
    _updateIcon() {
        // pick the light or dark glyph by the panel's text colour
        const c = this._panelBox.get_theme_node().get_foreground_color();
        const lightText = 0.299 * c.red + 0.587 * c.green + 0.114 * c.blue > 128;
        const live = !!this._model?.live;
        const name = `psl-panel-${lightText ? 'light' : 'dark'}${live ? '-live' : ''}.svg`;
        if (name !== this._iconName) {
            this._iconName = name;
            this._icon.gicon = new Gio.FileIcon({file: this._iconsDir.get_child(name)});
        }
    }

    _renderPanel() {
        const m = this._model;
        this._updateIcon();
        const items = m.mode === 'session' ? m.panel.items : [];
        this._items.forEach((w, i) => {
            const it = items[i];
            setVisible(w.item, !!it);
            if (!it)
                return;
            setText(w.pos, String(it.pos));
            setStyle(w.bar, colourStyle(it.colour));
            setText(w.tla, it.tla);
            setText(w.value, it.value);
            setVisible(w.value, !!it.value);
            setVisible(w.flag, !!it.chequered);
        });
        const chip = m.mode === 'session' ? m.panel.chip : null;
        setVisible(this._chip, !!chip);
        if (chip) {
            setText(this._chip, chip.text);
            setClass(this._chip, `psl-panel-chip chip-${chip.kind}`);
        }
        const showIdle = m.mode === 'idle' && m.settings.panelDrivers > 0 &&
            this._settings.get_boolean('show-next-session');
        setText(this._idle, showIdle ? m.idleText : '');
        setVisible(this._idle, showIdle && !!m.idleText);
    }

    // ------------------------------------------------------------- menu
    /**
     * Everything that decides which widgets the menu has. Data that only changes text,
     * colours or classes (times, gaps, positions) stays out of it.
     */
    _menuLayout(m) {
        const shape = {
            mode: m.mode, dark: m.dark, expanded: m.expanded, settings: m.settings,
            theme: this._settings.get_string('theme'), replay: m.replay, newVersion: this._newVersion,
        };
        if (m.mode === 'session') {
            Object.assign(shape, {
                kind: m.kind, live: m.live, columns: m.columns,
                sections: m.sections.map(sec => [sec.title, sec.style,
                    sec.rows.map(r => r.ext.map(c => (c.tyre ? 't' : c.narrow ? 'n' : 'x')).join(''))]),
                sectors: m.sectors ? !!m.sectors.ideal : null,
            });
        } else {
            shape.idleText = m.idleText;
        }
        return JSON.stringify(shape);
    }

    _renderMenu() {
        if (this._renderedKey === this._modelKey)
            return;
        this._renderedKey = this._modelKey;
        const m = this._model;
        const layout = this._menuLayout(m);
        if (this._ui && layout === this._layoutKey) {
            this._patchSession(m);
            return;
        }
        this._layoutKey = layout;
        this._ui = null;
        this._root.destroy_all_children();
        const aurora = this._settings.get_string('theme') === 'aurora' ? ' psl-aurora' : '';
        this._root.style_class = `psl-popup ${m.dark ? 'psl-dark' : 'psl-light'}${aurora}${m.expanded && m.mode === 'session' ? ' expanded' : ''}`;

        if (m.mode === 'session')
            this._renderSession(m);
        else
            this._renderIdle(m);

        this._root.add_child(this._separator());
        this._root.add_child(label(_('Next to the panel icon'), 'psl-caption psl-muted'));
        this._root.add_child(this._segmented(
            [[0, _('Icon only')], [1, '1'], [2, '2'], [3, '3']], m.settings.panelDrivers,
            v => this._settings.set_int('panel-drivers', v)));
        if (m.settings.panelDrivers > 0 && m.mode === 'session') {
            if (m.kind === 'race') {
                this._root.add_child(this._segmented(
                    [['leader', _('Gap to leader')], ['interval', _('Gap ahead')], ['both', _('Both')]],
                    m.settings.raceMode, v => this._settings.set_string('race-mode', v)));
            } else {
                this._root.add_child(this._segmented(
                    [['times', _('Lap times')], ['gap', _('Gap to P1')]],
                    m.settings.practiceMode, v => this._settings.set_string('practice-mode', v)));
            }
        }

        if (m.mode === 'session') {
            this._root.add_child(this._item(m.expanded ? _('Collapse table') : _('Expand table'),
                m.expanded ? 'pan-up-symbolic' : 'pan-down-symbolic',
                () => this._settings.set_boolean('expanded', !m.expanded), false));
        }
        if (m.replay) {
            this._root.add_child(this._item(_('Back to live timing'), 'media-playback-stop-symbolic',
                () => this._settings.set_boolean('demo-mode', false)));
        } else {
            if (m.mode !== 'session') {
                this._root.add_child(this._item(_('Connect now'), 'view-refresh-symbolic',
                    () => this._service.connectNow()));
            }
            this._root.add_child(this._item(_('Play demo race'), 'media-playback-start-symbolic',
                () => this._settings.set_boolean('demo-mode', true)));
        }
        this._root.add_child(this._item(_('Settings'), 'emblem-system-symbolic',
            () => this._extension.openPreferences()));
        if (!m.replay) {
            this._root.add_child(this._item(_('Refresh'), 'view-refresh-symbolic',
                () => this._service.refresh()));
        }
        if (this._newVersion) {
            // a newer package is installed, but GNOME Shell runs the old code until the next login
            this._root.add_child(this._item(View.sprintf(_('Version %s installed – log out to load it'), this._newVersion),
                'system-log-out-symbolic', () => this._logOut()));
        }
        this._root.add_child(this._item(_('Quit'), 'system-shutdown-symbolic', () => this._quit()));
    }

    _checkInstalledVersion() {
        const running = this._extension.metadata['version-name'] ?? '';
        let installed = '';
        try {
            const [ok, bytes] = this._extension.dir.get_child('metadata.json').load_contents(null);
            if (ok)
                installed = versionFromMetadata(new TextDecoder().decode(bytes));
        } catch {
            // file gone (package being replaced): nothing to offer
        }
        this._newVersion = isUpdateInstalled(running, installed) ? installed : '';
    }

    _logOut() {
        try {
            Gio.Subprocess.new(['gnome-session-quit', '--logout'], Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError(e, 'Purple Sector: log out');
        }
    }

    // Quit = switch the extension off (like the switch in the Extensions app); it stays off until switched on there
    _quit() {
        const uuid = this._extension.uuid;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            Main.extensionManager.disableExtension(uuid);
            return GLib.SOURCE_REMOVE;
        });
    }

    _renderIdle(m) {
        const head = box(true, {style_class: 'psl-head'});
        head.add_child(label(this._extension.metadata.name, 'psl-title'));
        head.add_child(label(m.idleText || _('No live session'), 'psl-muted'));
        this._root.add_child(head);
    }

    _renderSession(m) {
        const ui = {rows: [], sectors: null};
        const head = box(true, {style_class: 'psl-head'});
        const top = box(false);
        ui.title = label('', 'psl-title', {x_expand: true});
        top.add_child(ui.title);
        if (m.replay)
            top.add_child(label(_('DEMO'), 'psl-live'));
        else if (m.live)
            top.add_child(label(`● ${_('LIVE')}`, 'psl-live'));
        head.add_child(top);
        const sub = box(false, {style_class: 'psl-subrow'});
        ui.chip = label('', 'psl-chip');
        ui.info = label('', 'psl-info psl-muted');
        sub.add_child(ui.chip);
        sub.add_child(ui.info);
        head.add_child(sub);
        this._root.add_child(head);
        this._root.add_child(this._separator());

        const cols = box(false, {style_class: 'psl-cols psl-muted'});
        cols.add_child(label('P', 'psl-pos'));
        cols.add_child(label(_('Driver').toUpperCase(), '', {x_expand: true}));
        cols.add_child(label(m.columns.main[0].toUpperCase(), 'psl-c1'));
        cols.add_child(label(m.columns.main[1].toUpperCase(), 'psl-c2'));
        if (m.expanded) {
            const sample = m.sections[0]?.rows[0]?.ext ?? [];
            m.columns.ext.forEach((title, i) => {
                const cell = sample[i] ?? {};
                const cls = cell.tyre ? 'psl-tyrecell' : `psl-ext${cell.narrow ? ' narrow' : ''}`;
                cols.add_child(label(title.toUpperCase(), cls));
            });
        }
        this._root.add_child(cols);

        const list = box(true);
        for (const section of m.sections) {
            if (section.title)
                list.add_child(this._divider(section.title, section.style));
            for (const r of section.rows) {
                const row = this._makeRow(r, m.expanded);
                ui.rows.push(row);
                list.add_child(row.actor);
            }
        }
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        scroll.set_child(list);
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const maxHeight = Math.max(240, Math.floor((monitor?.height ?? 900) / scale) - 360);
        scroll.style = `max-height: ${maxHeight}px;`;
        this._root.add_child(scroll);

        if (m.sectors) {
            ui.sectors = this._makeSectors(m.sectors);
            this._root.add_child(ui.sectors.actor);
        }

        const legend = box(false, {style_class: 'psl-legend psl-muted'});
        legend.add_child(label('■', 'purple'));
        legend.add_child(label(m.kind === 'race' ? _('fastest lap') : _('best time'), 'psl-muted'));
        if (m.expanded) {
            legend.add_child(label('■', 'green'));
            legend.add_child(label(_('personal best'), 'psl-muted'));
        }
        ui.footer = label('', 'psl-muted', {x_expand: true, x_align: Clutter.ActorAlign.END});
        legend.add_child(ui.footer);
        this._root.add_child(legend);

        this._ui = ui;
        this._patchSession(m);
    }

    /** Puts the model's data into the widgets built by _renderSession (same layout). */
    _patchSession(m) {
        const ui = this._ui;
        setText(ui.title, m.title);
        setText(ui.chip, m.track.text);
        setClass(ui.chip, `psl-chip chip-${m.track.kind}`);
        setText(ui.info, m.info);
        let n = 0;
        for (const section of m.sections) {
            for (const r of section.rows) {
                this._patchRow(ui.rows[n], r, section.style, n, m.expanded);
                n++;
            }
        }
        if (ui.sectors)
            this._patchSectors(ui.sectors, m.sectors);
        setText(ui.footer, m.footer);
    }

    _makeSectors(sectors) {
        const w = {cells: []};
        w.actor = box(true, {style_class: 'psl-sectors'});
        const head = box(false);
        head.add_child(label(_('Fastest sectors').toUpperCase(), 'psl-muted psl-sectors-title', {x_expand: true}));
        if (sectors.ideal) {
            head.add_child(label(_('Ideal lap'), 'psl-muted psl-sectors-title'));
            w.ideal = label('', 'psl-sector-time psl-sector-ideal');
            head.add_child(w.ideal);
        }
        w.actor.add_child(head);
        const row = box(false, {style_class: 'psl-sector-row'});
        for (const s of sectors.items) {
            const cell = box(false, {style_class: 'psl-sector', x_expand: true});
            const c = {
                bar: new St.Widget({style_class: 'psl-bar', y_align: Clutter.ActorAlign.CENTER}),
                tla: label('', 'psl-sector-tla'),
                time: label('', 'psl-sector-time purple'),
            };
            cell.add_child(label(s.name, 'psl-muted'));
            cell.add_child(c.bar);
            cell.add_child(c.tla);
            cell.add_child(c.time);
            row.add_child(cell);
            w.cells.push(c);
        }
        w.actor.add_child(row);
        return w;
    }

    _patchSectors(w, sectors) {
        if (w.ideal)
            setText(w.ideal, sectors.ideal);
        sectors.items.forEach((s, i) => {
            const c = w.cells[i];
            if (!c)
                return;
            setStyle(c.bar, colourStyle(s.colour));
            setText(c.tla, s.tla);
            setText(c.time, s.time);
        });
    }

    _flagIcon(styleClass) {
        return new St.Icon({
            gicon: new Gio.FileIcon({file: this._iconsDir.get_child('psl-chequered.svg')}),
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _separator() {
        return new St.Widget({style_class: 'psl-separator'});
    }

    _divider(title, style) {
        const d = box(false, {style_class: `psl-divider ${style}`});
        const line = () => new St.Widget({
            style_class: 'psl-divider-line',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        d.add_child(line());
        d.add_child(label(title.toUpperCase()));
        d.add_child(line());
        return d;
    }

    /** Widgets of one table row; the ext cells follow the row's shape (part of the layout key). */
    _makeRow(r, expanded) {
        const w = {tagsKey: '', ext: []};
        w.actor = box(false, {style_class: 'psl-row'});
        w.pos = label('', 'psl-pos psl-muted');
        w.actor.add_child(w.pos);
        const driver = box(false, {x_expand: true, style_class: 'psl-driver'});
        w.bar = new St.Widget({style_class: 'psl-bar', y_align: Clutter.ActorAlign.CENTER});
        driver.add_child(w.bar);
        w.tla = label('', 'psl-tla');
        // A driver code is never shortened: wide bold letters (W, M) must not turn into "K…".
        w.tla.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        driver.add_child(w.tla);
        w.flag = this._flagIcon('psl-flag');
        w.flag.visible = false;
        driver.add_child(w.flag);
        if (expanded) {
            w.name = label('', 'psl-name psl-muted');
            driver.add_child(w.name);
        }
        w.tags = box(false, {style_class: 'psl-tags', visible: false});
        driver.add_child(w.tags);
        w.actor.add_child(driver);
        w.c1 = label('', 'psl-c1');
        w.c2 = label('', 'psl-c2 psl-muted');
        w.actor.add_child(w.c1);
        w.actor.add_child(w.c2);
        if (expanded) {
            for (const cell of r.ext) {
                if (cell.tyre) {
                    const actor = box(false, {style_class: 'psl-tyrecell'});
                    const tyre = label('', 'psl-tyre', {visible: false});
                    const age = label('', 'psl-muted', {visible: false});
                    actor.add_child(tyre);
                    actor.add_child(age);
                    w.actor.add_child(actor);
                    w.ext.push({tyre, age});
                } else {
                    const text = label('', 'psl-ext');
                    w.actor.add_child(text);
                    w.ext.push({text});
                }
            }
        }
        return w;
    }

    _patchRow(w, r, sectionStyle, index, expanded) {
        let cls = 'psl-row';
        if (sectionStyle === 'danger')
            cls += ' danger';
        else if (expanded && index % 2 === 1)
            cls += ' alt';
        if (r.dim)
            cls += ' dim';
        setClass(w.actor, cls);
        setText(w.pos, String(r.pos));
        setStyle(w.bar, colourStyle(r.colour));
        setText(w.tla, r.tla);
        setVisible(w.flag, !!r.chequered);
        if (w.name)
            setText(w.name, r.name);
        const tagsKey = r.tags.map(t => `${t.style}\u0001${t.text}`).join('\u0002');
        if (tagsKey !== w.tagsKey) {
            w.tagsKey = tagsKey;
            w.tags.destroy_all_children();
            for (const tag of r.tags)
                w.tags.add_child(label(tag.text, `psl-tag ${tag.style}`));
            setVisible(w.tags, r.tags.length > 0);
        }
        setText(w.c1, r.c1);
        setClass(w.c1, `psl-c1 ${r.c1Style}`);
        setText(w.c2, r.c2);
        w.ext.forEach((c, i) => {
            const cell = r.ext[i] ?? {};
            if (c.tyre) {
                const tyre = cell.tyre ?? {};
                setText(c.tyre, tyre.text);
                setClass(c.tyre, `psl-tyre ${tyre.style ?? ''}`);
                setVisible(c.tyre, !!tyre.text);
                setText(c.age, tyre.text ? tyre.age : '');
                setVisible(c.age, !!tyre.text);
            } else {
                setText(c.text, cell.text);
                setClass(c.text, `psl-ext${cell.narrow ? ' narrow' : ''} ${cell.style ?? ''}`);
            }
        });
    }

    _segmented(options, current, onPick) {
        const seg = box(false, {style_class: 'psl-segmented'});
        for (const [key, text] of options) {
            const button = new St.Button({
                label: text,
                style_class: 'psl-segment',
                toggle_mode: true,
                checked: key === current,
                x_expand: true,
                can_focus: true,
            });
            button.connect('clicked', () => onPick(key));
            seg.add_child(button);
        }
        return seg;
    }

    _item(text, iconName, onClick, closeMenu = true) {
        const button = new St.Button({style_class: 'psl-item', can_focus: true, x_expand: true});
        const content = box(false, {style_class: 'psl-item-box', x_expand: true});
        content.add_child(label(text, '', {x_expand: true}));
        content.add_child(new St.Icon({icon_name: iconName, icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
        button.set_child(content);
        button.connect('clicked', () => {
            if (closeMenu)
                this.menu.close();
            onClick();
        });
        return button;
    }
});
