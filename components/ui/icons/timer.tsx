import { TimerW300 } from "@material-symbols-svg/react/rounded/icons/timer";

import { iconProps, type IconProps } from "./icon-props";

export function TimerIcon(props: IconProps) {
  return <TimerW300 {...iconProps(props)} />;
}
