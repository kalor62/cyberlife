package iterm

import (
	"fmt"
	"strings"
)

// defaultTmuxColors is the palette reported for directly-watched tmux sessions
// (iTerm2 dark-background defaults, matching what the Python bridge used to send).
var defaultTmuxColors = ProfileColors{
	Fg:     "#c7c7c7",
	Bg:     "#000000",
	Cursor: "#c7c7c7",
	Ansi: []string{
		"#000000", "#c91b00", "#00c200", "#c7c400",
		"#0225c7", "#ca30c7", "#00c5c7", "#c7c7c7",
		"#686868", "#ff6e67", "#5ffa68", "#fffc67",
		"#6871ff", "#ff77ff", "#60fdff", "#ffffff",
	},
}

func xterm256Hex(n int) string {
	switch {
	case n < 0 || n > 255:
		return ""
	case n < 16:
		return defaultTmuxColors.Ansi[n]
	case n < 232:
		levels := [6]int{0, 95, 135, 175, 215, 255}
		n -= 16
		return fmt.Sprintf("#%02x%02x%02x", levels[n/36], levels[(n/6)%6], levels[n%6])
	default:
		v := 8 + 10*(n-232)
		return fmt.Sprintf("#%02x%02x%02x", v, v, v)
	}
}

// sgrState carries active text attributes across lines of a capture-pane -e dump
type sgrState struct {
	fg, bg      string
	bold, faint bool
	italic      bool
	underline   bool
	strike      bool
	inverse     bool
}

func (s *sgrState) reset() { *s = sgrState{} }

func (s *sgrState) apply(params []int) {
	if len(params) == 0 {
		s.reset()
		return
	}
	for i := 0; i < len(params); i++ {
		p := params[i]
		switch {
		case p == 0:
			s.reset()
		case p == 1:
			s.bold = true
		case p == 2:
			s.faint = true
		case p == 3:
			s.italic = true
		case p == 4:
			s.underline = true
		case p == 7:
			s.inverse = true
		case p == 9:
			s.strike = true
		case p == 22:
			s.bold, s.faint = false, false
		case p == 23:
			s.italic = false
		case p == 24:
			s.underline = false
		case p == 27:
			s.inverse = false
		case p == 29:
			s.strike = false
		case p >= 30 && p <= 37:
			s.fg = defaultTmuxColors.Ansi[p-30]
		case p == 39:
			s.fg = ""
		case p >= 40 && p <= 47:
			s.bg = defaultTmuxColors.Ansi[p-40]
		case p == 49:
			s.bg = ""
		case p >= 90 && p <= 97:
			s.fg = defaultTmuxColors.Ansi[p-90+8]
		case p >= 100 && p <= 107:
			s.bg = defaultTmuxColors.Ansi[p-100+8]
		case p == 38 || p == 48:
			color, consumed := extendedColor(params[i+1:])
			if consumed == 0 {
				return
			}
			if p == 38 {
				s.fg = color
			} else {
				s.bg = color
			}
			i += consumed
		}
	}
}

// extendedColor parses the tail of a 38/48 sequence: "5;n" or "2;r;g;b".
// Returns the number of params consumed, 0 when the sequence is malformed.
func extendedColor(rest []int) (string, int) {
	if len(rest) >= 2 && rest[0] == 5 {
		return xterm256Hex(rest[1]), 2
	}
	if len(rest) >= 4 && rest[0] == 2 {
		clamp := func(v int) int {
			if v < 0 {
				return 0
			}
			if v > 255 {
				return 255
			}
			return v
		}
		return fmt.Sprintf("#%02x%02x%02x", clamp(rest[1]), clamp(rest[2]), clamp(rest[3])), 4
	}
	return "", 0
}

func (s *sgrState) styledRun(text string) StyledRun {
	return StyledRun{
		Text:          text,
		FgColor:       s.fg,
		BgColor:       s.bg,
		Bold:          s.bold,
		Faint:         s.faint,
		Italic:        s.italic,
		Underline:     s.underline,
		Strikethrough: s.strike,
		Inverse:       s.inverse,
	}
}

// parseStyledScreen converts `capture-pane -e` output into styled lines,
// carrying SGR state across line breaks the way a terminal would.
func parseStyledScreen(raw string) [][]StyledRun {
	state := sgrState{}
	rawLines := strings.Split(raw, "\n")
	lines := make([][]StyledRun, len(rawLines))
	for i, l := range rawLines {
		lines[i] = parseStyledLine(l, &state)
	}
	return lines
}

func parseStyledLine(line string, state *sgrState) []StyledRun {
	runs := []StyledRun{}
	var text strings.Builder

	flush := func() {
		if text.Len() == 0 {
			return
		}
		runs = append(runs, state.styledRun(text.String()))
		text.Reset()
	}

	for i := 0; i < len(line); {
		c := line[i]
		if c != 0x1b {
			text.WriteByte(c)
			i++
			continue
		}
		if i+1 >= len(line) {
			break
		}
		switch line[i+1] {
		case '[':
			j := i + 2
			for j < len(line) && (line[j] < 0x40 || line[j] > 0x7e) {
				j++
			}
			if j >= len(line) {
				i = len(line)
				break
			}
			if line[j] == 'm' {
				flush()
				state.apply(parseSGRParams(line[i+2 : j]))
			}
			i = j + 1
		case ']':
			// OSC: consume until BEL or ST
			j := i + 2
			for j < len(line) && line[j] != 0x07 && (line[j] != 0x1b || j+1 >= len(line) || line[j+1] != '\\') {
				j++
			}
			if j < len(line) && line[j] == 0x1b {
				j++
			}
			i = j + 1
		default:
			// ESC + intermediates (0x20-0x2f) + final byte, e.g. charset "ESC ( B"
			j := i + 1
			for j < len(line) && line[j] >= 0x20 && line[j] <= 0x2f {
				j++
			}
			i = j + 1
		}
	}
	flush()
	return runs
}

func parseSGRParams(s string) []int {
	if s == "" {
		return nil
	}
	// Colon variants (38:5:n) normalize to the semicolon form
	s = strings.ReplaceAll(s, ":", ";")
	parts := strings.Split(s, ";")
	params := make([]int, 0, len(parts))
	for _, p := range parts {
		n := 0
		for _, ch := range p {
			if ch < '0' || ch > '9' {
				n = 0
				break
			}
			n = n*10 + int(ch-'0')
		}
		params = append(params, n)
	}
	return params
}
