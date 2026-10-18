'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Dialogs open on the page body, above everything (the top bar, the side menu): a page sits in its own layer, so a
// dialog drawn inside it would be covered by what is on top of that layer.
export function ModalPortal({children}:{children:ReactNode}) {
  const [ready,setReady] = useState(false);
  useEffect(()=>setReady(true),[]);
  return ready ? createPortal(children,document.body) : null;
}
