import { create } from 'zustand'

interface Secrets {
  aviabitToken: string
  mailToken: string
  visible: boolean
  setAviabit: (value: string) => void
  setMail: (value: string) => void
  setVisible: (value: boolean) => void
}

export const useSecrets = create<Secrets>((set) => ({
  aviabitToken: '',
  mailToken: '',
  visible: false,
  setAviabit: (aviabitToken) => set({ aviabitToken }),
  setMail: (mailToken) => set({ mailToken }),
  setVisible: (visible) => set({ visible }),
}))
