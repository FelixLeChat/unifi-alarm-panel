import { InfoW300 } from "@material-symbols-svg/react/rounded/icons/info"

import { iconProps, type IconProps } from "./icon-props"

export function InfoIcon(props: IconProps) {
  return <InfoW300 {...iconProps(props)} />
}
