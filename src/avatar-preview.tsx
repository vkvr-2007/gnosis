// Development only (avatar.html): the avatar on its own, in the pose named by ?pose=, so his drawing
// can be checked without starting the whole face. ?mouth=0.8 opens his mouth as if talking.
// ?capture=1 is what `npm run mascot` photographs for the desktop bubble: transparent, no halo,
// no fade at the bottom, every animation held at its start.
import { createRoot } from 'react-dom/client'
import { Avatar } from './ui/Avatar'

const params = new URLSearchParams(window.location.search)
const mouth = params.get('mouth')
if (params.get('capture')) document.documentElement.classList.add('capture')
createRoot(document.getElementById('root')!).render(<Avatar />)
if (mouth) {
  setTimeout(() => document.querySelector<HTMLElement>('.avatar')?.style.setProperty('--mouth', mouth), 50)
}
