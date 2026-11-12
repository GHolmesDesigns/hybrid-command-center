import type * as React from 'react';
export interface LogoProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'auto' | 'primary' | 'reverse';
  /** Floors at 120. */ width?: number;
  alt?: string;
  clearSpace?: boolean;
}
export declare function Logo(props: LogoProps): React.ReactElement;
export interface IconMarkProps {
  tone?: 'light' | 'dark';
  shape?: 'tile' | 'circle' | 'bare';
  size?: number;
  alt?: string;
  className?: string;
}
export declare function IconMark(props: IconMarkProps): React.ReactElement;
export interface AccentLineProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}
export declare function AccentLine(props: AccentLineProps): React.ReactElement;
export interface DotsProps {
  children?: React.ReactNode;
  className?: string;
}
export declare function Dots(props: DotsProps): React.ReactElement;
export interface RegistrationMarkProps {
  size?: number;
  misregistered?: boolean;
  alt?: string;
  className?: string;
}
export declare function RegistrationMark(props: RegistrationMarkProps): React.ReactElement;
export interface LabelProps {
  children?: React.ReactNode;
  tone?: 'muted' | 'ink' | 'highlight';
  size?: 'md' | 'sm';
  as?: React.ElementType;
  className?: string;
}
export declare function Label(props: LabelProps): React.ReactElement;
export interface HighlightProps {
  children?: React.ReactNode;
  tone?: 'cyan' | 'yellow' | 'magenta';
  className?: string;
}
export declare function Highlight(props: HighlightProps): React.ReactElement;
export interface SectionHeaderProps {
  title: React.ReactNode;
  number?: React.ReactNode;
  lede?: React.ReactNode;
  as?: React.ElementType;
  className?: string;
}
export declare function SectionHeader(props: SectionHeaderProps): React.ReactElement;
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'sm';
  href?: string;
}
export declare function Button(props: ButtonProps): React.ReactElement;
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  multiline?: boolean;
}
export declare function Input(props: InputProps): React.ReactElement;
export interface CardProps {
  title?: React.ReactNode;
  children?: React.ReactNode;
  tone?: 'default' | 'muted' | 'dark';
  className?: string;
}
export declare function Card(props: CardProps): React.ReactElement;
export interface CalloutProps {
  label?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}
export declare function Callout(props: CalloutProps): React.ReactElement;
export interface RuledListItem {
  title: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  number?: React.ReactNode;
}
export interface RuledListProps {
  items: RuledListItem[];
  className?: string;
}
export declare function RuledList(props: RuledListProps): React.ReactElement;
export interface DoDontProps {
  dos: React.ReactNode[];
  donts: React.ReactNode[];
  doTitle?: string;
  dontTitle?: string;
  className?: string;
}
export declare function DoDont(props: DoDontProps): React.ReactElement;
export interface CopyBlockProps {
  title?: string;
  caption?: string;
  meta?: React.ReactNode;
  className?: string;
}
export declare function CopyBlock(props: CopyBlockProps): React.ReactElement;
export interface PlaybookNavProps {
  items: { id: string; label: React.ReactNode }[];
  title?: React.ReactNode;
  activeId?: string;
  fixed?: boolean;
  label?: string;
  className?: string;
}
export declare function PlaybookNav(props: PlaybookNavProps): React.ReactElement;
export interface HeroProps {
  children?: React.ReactNode;
  lede?: React.ReactNode;
  nav?: React.ReactNode;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  className?: string;
}
export declare function Hero(props: HeroProps): React.ReactElement;
export interface BrandBandProps {
  children?: React.ReactNode;
  className?: string;
}
export declare function BrandBand(props: BrandBandProps): React.ReactElement;
export interface BusinessCardProps {
  name?: string;
  role?: string;
  className?: string;
}
export declare function BusinessCard(props: BusinessCardProps): React.ReactElement;
export interface LetterheadProps {
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}
export declare function Letterhead(props: LetterheadProps): React.ReactElement;
export interface SocialCardProps {
  children?: React.ReactNode;
  className?: string;
}
export declare function SocialCard(props: SocialCardProps): React.ReactElement;
declare global {
  interface Window {
    GHolmes: {
      Logo: typeof Logo;
      IconMark: typeof IconMark;
      AccentLine: typeof AccentLine;
      Dots: typeof Dots;
      RegistrationMark: typeof RegistrationMark;
      Label: typeof Label;
      Highlight: typeof Highlight;
      SectionHeader: typeof SectionHeader;
      Button: typeof Button;
      Input: typeof Input;
      Card: typeof Card;
      Callout: typeof Callout;
      RuledList: typeof RuledList;
      DoDont: typeof DoDont;
      CopyBlock: typeof CopyBlock;
      PlaybookNav: typeof PlaybookNav;
      Hero: typeof Hero;
      BrandBand: typeof BrandBand;
      BusinessCard: typeof BusinessCard;
      Letterhead: typeof Letterhead;
      SocialCard: typeof SocialCard;
    };
  }
}
