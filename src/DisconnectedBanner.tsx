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

import classNames from "classnames";
import React, { HTMLAttributes, ReactNode } from "react";
import { logger } from "@sentry/utils";
import { Trans } from "react-i18next";

import styles from "./DisconnectedBanner.module.css";
import { useClient } from "./ClientContext";

interface DisconnectedBannerProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
  className?: string;
}

export function DisconnectedBanner({
  children,
  className,
  ...rest
}: DisconnectedBannerProps) {
  const clientrp = useClient();
  logger.log(clientrp);
  const disconnected = clientrp.disconnected;
  return (
    <>
      {disconnected && (
        <Trans>
          <div className={classNames(styles.banner, className)} {...rest}>
            {children}
            Connectivity to the server has been lost.
          </div>
        </Trans>
      )}
    </>
  );
}
