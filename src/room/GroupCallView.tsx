/*
Copyright 2022 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHistory } from "react-router-dom";
import { GroupCall, GroupCallState } from "matrix-js-sdk/src/webrtc/groupCall";
import { MatrixClient } from "matrix-js-sdk/src/client";
import { useTranslation } from "react-i18next";
import { Room } from "livekit-client";
import { logger } from "matrix-js-sdk/src/logger";

import type { IWidgetApiRequest } from "matrix-widget-api";
import { widget, ElementWidgetActions, JoinCallData } from "../widget";
import { useGroupCall } from "./useGroupCall";
import { ErrorView, FullScreenView } from "../FullScreenView";
import { LobbyView } from "./LobbyView";
import { MatrixInfo } from "./VideoPreview";
import { CallEndedView } from "./CallEndedView";
import { useSentryGroupCallHandler } from "./useSentryGroupCallHandler";
import { PosthogAnalytics } from "../analytics/PosthogAnalytics";
import { useProfile } from "../profile/useProfile";
import { E2EEConfig } from "../livekit/useLiveKit";
import { findDeviceByName } from "../media-utils";
import { OpenIDLoader } from "../livekit/OpenIDLoader";
import { ActiveCall } from "./InCallView";
import { Config } from "../config/Config";
import { MuteStates, useMuteStates } from "./MuteStates";
import { useMediaDevices, MediaDevices } from "../livekit/MediaDevicesContext";

declare global {
  interface Window {
    groupCall?: GroupCall;
  }
}

interface Props {
  client: MatrixClient;
  isPasswordlessUser: boolean;
  isEmbedded: boolean;
  preload: boolean;
  hideHeader: boolean;
  groupCall: GroupCall;
}

export function GroupCallView({
  client,
  isPasswordlessUser,
  isEmbedded,
  preload,
  hideHeader,
  groupCall,
}: Props) {
  const {
    state,
    error,
    enter,
    leave,
    participants,
    unencryptedEventsFromUsers,
    otelGroupCallMembership,
  } = useGroupCall(groupCall, client);

  const { t } = useTranslation();

  useEffect(() => {
    window.groupCall = groupCall;
    return () => {
      delete window.groupCall;
    };
  }, [groupCall]);

  const { displayName, avatarUrl } = useProfile(client);
  const matrixInfo = useMemo((): MatrixInfo => {
    return {
      displayName: displayName!,
      avatarUrl: avatarUrl!,
      roomId: groupCall.room.roomId,
      roomName: groupCall.room.name,
      roomAlias: groupCall.room.getCanonicalAlias(),
    };
  }, [displayName, avatarUrl, groupCall]);

  const deviceContext = useMediaDevices();
  const latestDevices = useRef<MediaDevices>();
  latestDevices.current = deviceContext;

  const muteStates = useMuteStates(participants.size);
  const latestMuteStates = useRef<MuteStates>();
  latestMuteStates.current = muteStates;

  useEffect(() => {
    if (widget && preload) {
      // In preload mode, wait for a join action before entering
      const onJoin = async (ev: CustomEvent<IWidgetApiRequest>) => {
        // XXX: I think this is broken currently - LiveKit *won't* request
        // permissions and give you device names unless you specify a kind, but
        // here we want all kinds of devices. This needs a fix in livekit-client
        // for the following name-matching logic to do anything useful.
        const devices = await Room.getLocalDevices(undefined, true);

        const { audioInput, videoInput } = ev.detail
          .data as unknown as JoinCallData;

        if (audioInput === null) {
          latestMuteStates.current!.audio.setEnabled?.(false);
        } else {
          const deviceId = await findDeviceByName(
            audioInput,
            "audioinput",
            devices
          );
          if (!deviceId) {
            logger.warn("Unknown audio input: " + audioInput);
            latestMuteStates.current!.audio.setEnabled?.(false);
          } else {
            logger.debug(
              `Found audio input ID ${deviceId} for name ${audioInput}`
            );
            latestDevices.current!.audioInput.select(deviceId);
            latestMuteStates.current!.audio.setEnabled?.(true);
          }
        }

        if (videoInput === null) {
          latestMuteStates.current!.video.setEnabled?.(true);
        } else {
          const deviceId = await findDeviceByName(
            videoInput,
            "videoinput",
            devices
          );
          if (!deviceId) {
            logger.warn("Unknown video input: " + videoInput);
            latestMuteStates.current!.video.setEnabled?.(false);
          } else {
            logger.debug(
              `Found video input ID ${deviceId} for name ${videoInput}`
            );
            latestDevices.current!.videoInput.select(deviceId);
            latestMuteStates.current!.video.setEnabled?.(true);
          }
        }

        await enter();

        PosthogAnalytics.instance.eventCallEnded.cacheStartCall(new Date());
        PosthogAnalytics.instance.eventCallStarted.track(groupCall.groupCallId);

        await Promise.all([
          widget!.api.setAlwaysOnScreen(true),
          widget!.api.transport.reply(ev.detail, {}),
        ]);
      };

      widget.lazyActions.on(ElementWidgetActions.JoinCall, onJoin);
      return () => {
        widget!.lazyActions.off(ElementWidgetActions.JoinCall, onJoin);
      };
    }
  }, [groupCall, preload, enter]);

  useEffect(() => {
    if (isEmbedded && !preload) {
      // In embedded mode, bypass the lobby and just enter the call straight away
      enter();

      PosthogAnalytics.instance.eventCallEnded.cacheStartCall(new Date());
      PosthogAnalytics.instance.eventCallStarted.track(groupCall.groupCallId);
    }
  }, [groupCall, isEmbedded, preload, enter]);

  useSentryGroupCallHandler(groupCall);

  const [left, setLeft] = useState(false);
  const [leaveError, setLeaveError] = useState<Error | undefined>(undefined);
  const history = useHistory();

  const onLeave = useCallback(
    async (leaveError?: Error) => {
      setLeaveError(leaveError);
      setLeft(true);

      let participantCount = 0;
      for (const deviceMap of groupCall.participants.values()) {
        participantCount += deviceMap.size;
      }

      // In embedded/widget mode the iFrame will be killed right after the call ended prohibiting the posthog event from getting sent,
      // therefore we want the event to be sent instantly without getting queued/batched.
      const sendInstantly = !!widget;
      PosthogAnalytics.instance.eventCallEnded.track(
        groupCall.groupCallId,
        participantCount,
        sendInstantly
      );

      leave();
      if (widget) {
        // we need to wait until the callEnded event is tracked. Otherwise the iFrame gets killed before the callEnded event got tracked.
        await new Promise((resolve) => window.setTimeout(resolve, 10)); // 10ms
        widget.api.setAlwaysOnScreen(false);
        PosthogAnalytics.instance.logout();
        widget.api.transport.send(ElementWidgetActions.HangupCall, {});
      }

      if (
        !isPasswordlessUser &&
        !isEmbedded &&
        !PosthogAnalytics.instance.isEnabled()
      ) {
        history.push("/");
      }
    },
    [groupCall, leave, isPasswordlessUser, isEmbedded, history]
  );

  useEffect(() => {
    if (widget && state === GroupCallState.Entered) {
      const onHangup = async (ev: CustomEvent<IWidgetApiRequest>) => {
        leave();
        await widget!.api.transport.reply(ev.detail, {});
        widget!.api.setAlwaysOnScreen(false);
      };
      widget.lazyActions.once(ElementWidgetActions.HangupCall, onHangup);
      return () => {
        widget!.lazyActions.off(ElementWidgetActions.HangupCall, onHangup);
      };
    }
  }, [groupCall, state, leave]);

  const [e2eeConfig, setE2EEConfig] = useState<E2EEConfig | undefined>(
    undefined
  );

  const onReconnect = useCallback(() => {
    setLeft(false);
    setLeaveError(undefined);
    groupCall.enter();
  }, [groupCall]);

  const livekitServiceURL =
    groupCall.livekitServiceURL ?? Config.get().livekit?.livekit_service_url;
  if (!livekitServiceURL) {
    return <ErrorView error={new Error("No livekit_service_url defined")} />;
  }

  if (error) {
    return <ErrorView error={error} />;
  } else if (state === GroupCallState.Entered) {
    return (
      <OpenIDLoader
        client={client}
        groupCall={groupCall}
        roomName={`${groupCall.room.roomId}-${groupCall.groupCallId}`}
      >
        <ActiveCall
          client={client}
          groupCall={groupCall}
          participants={participants}
          onLeave={onLeave}
          unencryptedEventsFromUsers={unencryptedEventsFromUsers}
          hideHeader={hideHeader}
          muteStates={muteStates}
          e2eeConfig={e2eeConfig}
          otelGroupCallMembership={otelGroupCallMembership}
        />
      </OpenIDLoader>
    );
  } else if (left) {
    // The call ended view is shown for two reasons: prompting guests to create
    // an account, and prompting users that have opted into analytics to provide
    // feedback. We don't show a feedback prompt to widget users however (at
    // least for now), because we don't yet have designs that would allow widget
    // users to dismiss the feedback prompt and close the call window without
    // submitting anything.
    if (
      isPasswordlessUser ||
      (PosthogAnalytics.instance.isEnabled() && !isEmbedded) ||
      leaveError
    ) {
      return (
        <CallEndedView
          endedCallId={groupCall.groupCallId}
          client={client}
          isPasswordlessUser={isPasswordlessUser}
          leaveError={leaveError}
          reconnect={onReconnect}
        />
      );
    } else {
      // If the user is a regular user, we'll have sent them back to the homepage,
      // so just sit here & do nothing: otherwise we would (briefly) mount the
      // LobbyView again which would open capture devices again.
      return null;
    }
  } else if (preload) {
    return null;
  } else if (isEmbedded) {
    return (
      <FullScreenView>
        <h1>{t("Loading…")}</h1>
      </FullScreenView>
    );
  } else {
    return (
      <LobbyView
        matrixInfo={matrixInfo}
        muteStates={muteStates}
        onEnter={(e2eeConfig?: E2EEConfig) => {
          setE2EEConfig(e2eeConfig);
          enter();
        }}
        isEmbedded={isEmbedded}
        hideHeader={hideHeader}
      />
    );
  }
}
