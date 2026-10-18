// Development only (avatar.html): the avatar on its own, in the pose named by ?pose=, so his drawing
// can be checked without starting the whole face. ?mouth=0.8 opens his mouth as if talking.
import { createRoot } from 'react-dom/client'
import { Avatar } from './ui/Avatar'

const mouth = new URLSearchParams(window.location.search).get('mouth')
createRoot(document.getElementById('root')!).render(<Avatar />)
if (mouth) {
  setTimeout(() => document.querySelector<HTMLElement>('.avatar')?.style.setProperty('--mouth', mouth), 50)
}
