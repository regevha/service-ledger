import { createContext, useContext, useEffect } from 'react';

/**
 * What the screen on show tells the app about itself, so that leaving it can ask first when there are
 * edits that leaving would lose. `scope` says which tab owns the screen: the intake flow ('new') survives
 * a move to its own tab, a saved report ('reports') does not survive any move.
 */
export interface LeaveGuard {
  scope: 'new' | 'reports';
  /** There are edits that leaving would lose. */
  dirty: boolean;
  /** Save them. Resolves true when saved, false when saving failed (the screen shows why). */
  save: () => Promise<boolean>;
}

export interface NavigationGuardApi {
  setGuard: (guard: LeaveGuard | null) => void;
  /** Run `leave` now, or once the person has chosen when the screen on show has unsaved edits. */
  confirmLeave: (leave: () => void, message?: string) => void;
}

// With no provider (a screen rendered on its own) nothing is guarded and leaving just happens.
export const NavigationGuardContext = createContext<NavigationGuardApi>({
  setGuard: () => {},
  confirmLeave: (leave) => leave(),
});

/** Register the screen's unsaved-edit state with the app for as long as it is mounted. */
export function useNavigationGuard(scope: LeaveGuard['scope'], dirty: boolean, save: () => Promise<boolean>) {
  const { setGuard } = useContext(NavigationGuardContext);
  // Every render: `save` closes over the form as it is now.
  useEffect(() => {
    setGuard({ scope, dirty, save });
    return () => setGuard(null);
  });
}

/** For a screen's own ways out (Back, Open that report): asks first only when there are unsaved edits. */
export function useConfirmLeave() {
  return useContext(NavigationGuardContext).confirmLeave;
}
