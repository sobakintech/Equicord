/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { UserAreaButton, UserAreaRenderProps } from "@api/UserArea";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import { ChannelStore, MediaEngineStore, SelectedChannelStore } from "@webpack/common";

const SocketModule = findByPropsLazy("getSocket");

// Discord's own icons: eye = real (visible) view, eye-slash = fake (hidden) view.
const EyeIcon = findComponentByCodeLazy("M22.89 11.7c.07.2.07.4 0 .6");
const EyeSlashIcon = findComponentByCodeLazy("M8.18 10.81c-.13.43.36.65.67.34");

const settings = definePluginSettings({
    // Runtime state, all persisted. `fakeView` = which state the mute/deafen buttons currently
    // edit/show (real vs fake). `fakeMute`/`fakeDeaf` = the fake broadcast state. Hidden from the
    // settings UI; driven by the view switch + the mute/deafen buttons while in fake view.
    fakeView: {
        type: OptionType.BOOLEAN,
        description: "Buttons currently editing the fake state",
        default: false,
        hidden: true
    },
    fakeMute: {
        type: OptionType.BOOLEAN,
        description: "Broadcasting fake mute",
        default: false,
        hidden: true
    },
    fakeDeaf: {
        type: OptionType.BOOLEAN,
        description: "Broadcasting fake deafen",
        default: false,
        hidden: true
    }
});

const anyFake = () => settings.store.fakeMute || settings.store.fakeDeaf;

// Push the current voice state to the gateway so others see the fake change immediately.
// The voiceStateUpdate patch rewrites self_mute/self_deaf on the way out based on the fake
// state; local audio (MediaEngine) is never touched, so you keep hearing/talking.
function resync() {
    try {
        const socket = SocketModule?.getSocket?.();
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (!socket || !channelId) return;

        const channel = ChannelStore.getChannel(channelId);
        const engine = MediaEngineStore as any;

        socket.voiceStateUpdate({
            guildId: channel?.guild_id ?? null,
            channelId,
            selfMute: engine.isSelfMute(),
            selfDeaf: engine.isSelfDeaf(),
            selfVideo: engine.isVideoEnabled()
        });
    } catch (err) {
        console.error("[FakeDeafen] failed to resync voice state", err);
    }
}

function ViewSwitchIcon({ className, fake }: { className?: string; fake: boolean; }) {
    const Icon = fake ? EyeSlashIcon : EyeIcon;
    return <Icon className={className} color={fake ? "var(--status-danger)" : "currentColor"} />;
}

function ViewSwitchButton({ iconForeground, hideTooltips, nameplate }: UserAreaRenderProps) {
    const { fakeView } = settings.use(["fakeView"]);

    return (
        <UserAreaButton
            tooltipText={hideTooltips ? void 0 : fakeView ? "Editing fake state — click for real" : "Editing real state — click for fake"}
            icon={<ViewSwitchIcon className={iconForeground} fake={fakeView} />}
            role="switch"
            aria-checked={fakeView}
            redGlow={fakeView}
            plated={nameplate != null}
            onClick={() => {
                settings.store.fakeView = !settings.store.fakeView;
            }}
        />
    );
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Adds a view-switch button next to your mute/deafen controls. In fake view, the same buttons control what others see (deafened/muted) while your real audio is untouched — real view leaves everything normal.",
    authors: [{ name: "SobakinTech", id: 0n }],
    dependencies: ["UserAreaAPI"],
    settings,

    // The view-switch button, placed next to the mute/deafen buttons via the supported UserArea
    // API (same slot GameActivityToggle uses) — robust, no fragile patch needed for the button.
    userAreaButton: {
        icon: ({ className }: { className?: string; }) => <ViewSwitchIcon className={className} fake={settings.store.fakeView} />,
        render: ViewSwitchButton
    },

    patches: [
        // Rewrite the outgoing voice state so others see the fake state. If no fake state is
        // set, the real state is broadcast. Deafen implies mute, like the real deafen button.
        // Local audio is never touched.
        {
            find: "self_mute:i,self_deaf:r,self_video:a,flags:d",
            replacement: {
                match: /self_mute:(\i),self_deaf:(\i),self_video:/,
                replace: "self_mute:$self.spoofMute($1),self_deaf:$self.spoofDeaf($2),self_video:"
            }
        },
        // In fake view, make the real mute button show + edit the fake state. Independent patch
        // so a miss here can't take down the deafen patch or the switch button.
        {
            find: "accountContainerRef:",
            replacement: {
                match: /(\{accountContainerRef:\i,selfMute:)(\i)(,serverMute:\i,suppress:\i,awaitingRemote:\i,onMouseEnter:\i,onMouseLeave:\i,onClick:)(\i)/,
                replace: "$1$self.useViewMute($2)$3$self.muteClick($4)"
            }
        },
        // In fake view, make the real deafen button show + edit the fake state.
        {
            find: "accountContainerRef:",
            replacement: {
                match: /(\{selfDeaf:)(\i)(,serverDeaf:\i,onClick:)(\i)(,onContextMenu)/,
                replace: "$1$self.useViewDeaf($2)$3$self.deafClick($4)$5"
            }
        }
    ],

    // ---- Outgoing broadcast (fake overrides real; deafen implies mute) ----
    spoofMute(realMute: boolean) {
        return anyFake() ? true : realMute;
    },
    spoofDeaf(realDeaf: boolean) {
        return settings.store.fakeDeaf ? true : realDeaf;
    },

    // ---- Account-panel injections (run inside the panel's function component, so these use
    // settings.use to subscribe it and re-render the buttons live when the fake state changes) ----
    useViewMute(realMute: boolean) {
        const { fakeView, fakeMute, fakeDeaf } = settings.use(["fakeView", "fakeMute", "fakeDeaf"]);
        return fakeView ? fakeMute || fakeDeaf : realMute;
    },
    useViewDeaf(realDeaf: boolean) {
        const { fakeView, fakeDeaf } = settings.use(["fakeView", "fakeDeaf"]);
        return fakeView ? fakeDeaf : realDeaf;
    },

    muteClick(original: (...args: any[]) => any) {
        return (...args: any[]) => {
            if (!settings.store.fakeView) return original?.(...args);
            settings.store.fakeMute = !settings.store.fakeMute;
            resync();
        };
    },
    deafClick(original: (...args: any[]) => any) {
        return (...args: any[]) => {
            if (!settings.store.fakeView) return original?.(...args);
            settings.store.fakeDeaf = !settings.store.fakeDeaf;
            resync();
        };
    }
});
