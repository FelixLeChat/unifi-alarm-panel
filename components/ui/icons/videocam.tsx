import { VideocamW300 } from "@material-symbols-svg/react/rounded/icons/videocam";

import { iconProps, type IconProps } from "./icon-props";

export function VideocamIcon(props: IconProps) {
  return <VideocamW300 {...iconProps(props)} />;
}
