import { PinW300 } from "@material-symbols-svg/react/rounded/icons/pin";

import { iconProps, type IconProps } from "./icon-props";

export function PinIcon(props: IconProps) {
  return <PinW300 {...iconProps(props)} />;
}
