import { SearchW300 } from "@material-symbols-svg/react/rounded/icons/search"

import { iconProps, type IconProps } from "./icon-props"

export function SearchIcon(props: IconProps) {
  return <SearchW300 {...iconProps(props)} />
}
