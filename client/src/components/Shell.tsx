import { useEffect, useRef, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export function Nav({
  icon,
  to,
  label,
  collapsed,
}: {
  icon: ReactNode;
  to: string;
  label: string;
  collapsed: boolean;
}) {
  return (
    <NavLink to={to} end={to === '/'} title={label}>
      {icon}
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}

export function PageHead({
  eyebrow,
  title,
  body,
  action,
  focusOnMount = false,
}: {
  eyebrow: string;
  title: string;
  body: string;
  action?: ReactNode;
  focusOnMount?: boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) titleRef.current?.focus();
  }, [focusOnMount]);
  return (
    <div className="page-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1 ref={titleRef} tabIndex={focusOnMount ? -1 : undefined}>
          {title}
        </h1>
        <p>{body}</p>
      </div>
      {action}
    </div>
  );
}
