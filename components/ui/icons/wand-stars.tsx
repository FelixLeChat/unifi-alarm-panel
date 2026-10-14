import { WandStarsW300 } from "@material-symbols-svg/react/rounded/icons/wand-stars"

import { iconProps, type IconProps } from "./icon-props"

export function WandStarsIcon(props: IconProps) {
  return <WandStarsW300 {...iconProps(props)} />
}
