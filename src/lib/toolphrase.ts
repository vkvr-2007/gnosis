/**
 * A tool's name as a person would say it, for the status line: "mcp__ayra_memory__remember" (or the
 * "memory · remember" the bridge client passes on) → "Remembering". The servers keep AYRA's
 * ayra_ prefix inside the bridge; the owner never sees it.
 */
const KNOWN: Record<string, string> = {
  browser_play_youtube: 'Finding a video on YouTube',
  browser_open: 'Opening a page',
  browser_read: 'Reading the page',
  browser_click: 'Clicking in Chrome',
  browser_type: 'Typing in Chrome',
  browser_tabs: 'Looking at your tabs',
  browser_close: 'Closing a tab',
  browser_screenshot: 'Looking at the page',
  apps_list: 'Looking at your windows',
  apps_open: 'Opening an app',
  apps_read: 'Reading the window',
  apps_click: 'Clicking in the app',
  apps_type: 'Typing in the app',
  apps_press: 'Pressing a key',
  apps_focus: 'Switching windows',
  apps_close: 'Closing the app',
  apps_screenshot: 'Looking at the window',
  remember: 'Remembering',
  search_memory: 'Checking my memory',
  forget: 'Forgetting',
  set_reminder: 'Setting a reminder',
  schedule_routine: 'Scheduling it',
  list_reminders: 'Checking your reminders',
  cancel_reminder: 'Cancelling the reminder',
  do_not_disturb: 'Going quiet',
  briefing: 'Putting your briefing together',
  morning_briefing_time: 'Moving your briefing',
  look_at_screen: 'Looking at your screen',
  look_through_camera: 'Looking through the camera',
  vision_click: 'Clicking by sight',
  spotify_play: 'Finding it on Spotify',
  look_at_attachment: 'Looking at your picture',
  learn_my_voice: 'Getting ready to learn your voice',
  code_start: 'Starting Claude Code',
  code_continue: 'Handing it to Claude Code',
  code_status: 'Checking the coding job',
  code_stop: 'Stopping the coding job',
  code_open: 'Opening Claude Code',
  voice_id_status: 'Checking voice ID',
  forget_my_voice: 'Forgetting your voice',
  teach_start: 'Watching you',
  teach_stop: 'Going over what you did',
  save_skill: 'Saving the skill',
  run_skill: 'Running your skill',
  list_skills: 'Checking your skills',
  delete_skill: 'Deleting the skill',
  phone_status: 'Checking your phone',
  set_up_phone: 'Setting up your phone',
  list_devices: 'Checking your devices',
  forget_device: 'Unpairing the device',
  phone_pair: 'Pairing your phone',
  phone_connect: 'Connecting to your phone',
  phone_call: 'Calling from your phone',
  phone_hang_up: 'Hanging up',
  phone_send_message: 'Sending from your phone',
  phone_open_app: 'Opening it on your phone',
  phone_notifications: 'Reading your phone',
  phone_find_contact: 'Looking up the contact',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a page',
  PowerShell: 'Running a command',
  Bash: 'Running a command',
  Read: 'Reading a file',
  Write: 'Writing a file',
  Edit: 'Editing a file',
  Glob: 'Looking for files',
  Grep: 'Searching your files',
  research: 'Researching',
  deep_research: 'Researching in depth',
}

/** The tool part of a name, raw ("mcp__server__tool") or as the bridge client words it ("server · tool"). */
export function toolOf(name: string): string {
  if (name.includes(' · ')) return name.split(' · ').pop()!.trim().replace(/ /g, '_')
  return name.split('__').pop() ?? name
}

export function toolPhrase(name: string): string {
  const tool = toolOf(name)
  if (KNOWN[tool]) return KNOWN[tool]
  const words = tool.replace(/^(?:apps|browser|jobs|rules)_/, '').replace(/[_-]+/g, ' ').trim()
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Working'
}
