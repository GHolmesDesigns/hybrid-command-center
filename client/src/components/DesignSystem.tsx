import React from 'react';
import type {
  ButtonProps,
  CardProps,
  InputProps,
} from '../../../docs/design-system/components/index';

export function GhdButton(props: ButtonProps) {
  return React.createElement(window.GHolmes.Button, props);
}

export function GhdCard(props: CardProps) {
  return React.createElement(window.GHolmes.Card, props);
}

export function GhdInput(props: InputProps) {
  return React.createElement(window.GHolmes.Input, props);
}
