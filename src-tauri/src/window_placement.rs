#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    fn right(self) -> i32 {
        self.x + self.width
    }

    fn bottom(self) -> i32 {
        self.y + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

impl Side {
    fn other(self) -> Self {
        match self {
            Self::Left => Self::Right,
            Self::Right => Self::Left,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub rect: Rect,
    pub side: Side,
}

pub fn place_adjacent(
    source: Rect,
    work_area: Rect,
    preferred_size: Size,
    minimum_size: Size,
    gap: i32,
    preferred_side: Option<Side>,
    cascade_index: usize,
) -> Placement {
    let left_space = (source.x - gap - work_area.x).max(0);
    let right_space = (work_area.right() - source.right() - gap).max(0);
    let preferred = preferred_side.unwrap_or(Side::Right);
    let space_on = |side| match side {
        Side::Left => left_space,
        Side::Right => right_space,
    };
    let side = if preferred_side.is_some() && space_on(preferred) >= minimum_size.width {
        preferred
    } else if space_on(preferred) >= preferred_size.width {
        preferred
    } else if space_on(preferred.other()) >= preferred_size.width {
        preferred.other()
    } else if space_on(preferred) >= minimum_size.width {
        preferred
    } else if space_on(preferred.other()) >= minimum_size.width {
        preferred.other()
    } else if right_space >= left_space {
        Side::Right
    } else {
        Side::Left
    };
    let fits_beside = space_on(side) >= minimum_size.width;
    let width = if fits_beside {
        preferred_size
            .width
            .min(space_on(side))
            .max(minimum_size.width)
    } else {
        minimum_size.width
    };

    // In a cascade, leave the earlier windows' title bars visible.
    let step = cascade_index.min(8) as i32 * 28;
    let vertical_reserve = if fits_beside { step } else { step.max(32) };
    let height = preferred_size
        .height
        .min(work_area.height - vertical_reserve)
        .max(minimum_size.height);
    let base_x = match (side, fits_beside) {
        (Side::Right, true) => source.right() + gap,
        (Side::Left, true) => source.x - gap - width,
        (Side::Right, false) => work_area.right() - width,
        (Side::Left, false) => work_area.x,
    };
    let x = clamp(
        base_x + if side == Side::Left { step } else { -step },
        work_area.x,
        work_area.right() - width,
    );
    let base_y = source.y + if fits_beside { 0 } else { 32 };
    let y = clamp(base_y + step, work_area.y, work_area.bottom() - height);

    Placement {
        rect: Rect {
            x,
            y,
            width,
            height,
        },
        side,
    }
}

fn clamp(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        min
    } else {
        value.clamp(min, max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_month_to_right_and_shrinks_to_available_width() {
        let placement = place_adjacent(
            Rect {
                x: 0,
                y: 0,
                width: 390,
                height: 768,
            },
            Rect {
                x: 0,
                y: 0,
                width: 1366,
                height: 728,
            },
            Size {
                width: 1180,
                height: 820,
            },
            Size {
                width: 900,
                height: 640,
            },
            12,
            None,
            0,
        );
        assert_eq!(placement.side, Side::Right);
        assert_eq!(placement.rect.x, 402);
        assert_eq!(placement.rect.width, 964);
        assert_eq!(placement.rect.height, 728);
    }

    #[test]
    fn uses_left_side_when_right_side_is_too_narrow() {
        let placement = place_adjacent(
            Rect {
                x: 1450,
                y: 100,
                width: 390,
                height: 800,
            },
            Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
            },
            Size {
                width: 1180,
                height: 820,
            },
            Size {
                width: 900,
                height: 640,
            },
            12,
            None,
            0,
        );
        assert_eq!(placement.side, Side::Left);
        assert_eq!(placement.rect.x, 258);
        assert_eq!(placement.rect.y, 100);
    }

    #[test]
    fn keeps_full_width_when_left_has_more_room() {
        let placement = place_adjacent(
            Rect {
                x: 1250,
                y: 0,
                width: 390,
                height: 820,
            },
            Rect {
                x: 0,
                y: 0,
                width: 2560,
                height: 1400,
            },
            Size {
                width: 1180,
                height: 820,
            },
            Size {
                width: 900,
                height: 640,
            },
            12,
            None,
            0,
        );
        assert_eq!(placement.side, Side::Left);
        assert_eq!(placement.rect.width, 1180);
    }

    #[test]
    fn fallback_keeps_the_source_title_bar_visible() {
        let placement = place_adjacent(
            Rect {
                x: 500,
                y: 0,
                width: 390,
                height: 768,
            },
            Rect {
                x: 0,
                y: 0,
                width: 1280,
                height: 768,
            },
            Size {
                width: 1180,
                height: 820,
            },
            Size {
                width: 900,
                height: 640,
            },
            12,
            None,
            0,
        );
        assert_eq!(placement.rect.width, 900);
        assert_eq!(placement.rect.y, 32);
        assert_eq!(placement.rect.height, 736);
    }

    #[test]
    fn cascades_day_windows_without_leaving_the_work_area() {
        let source = Rect {
            x: 402,
            y: 0,
            width: 1180,
            height: 820,
        };
        let work = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let first = place_adjacent(
            source,
            work,
            Size {
                width: 400,
                height: 820,
            },
            Size {
                width: 360,
                height: 520,
            },
            12,
            Some(Side::Left),
            0,
        );
        let second = place_adjacent(
            source,
            work,
            Size {
                width: 400,
                height: 820,
            },
            Size {
                width: 360,
                height: 520,
            },
            12,
            Some(Side::Left),
            1,
        );
        assert_eq!(first.rect.x, 0);
        assert_eq!(first.rect.y, 0);
        assert_eq!(second.rect.x, 28);
        assert_eq!(second.rect.y, 28);
        assert!(second.rect.right() <= work.right());
        assert!(second.rect.bottom() <= work.bottom());
    }

    #[test]
    fn respects_a_monitor_left_of_the_primary_screen() {
        let work = Rect {
            x: -1920,
            y: -40,
            width: 1920,
            height: 1040,
        };
        let placement = place_adjacent(
            Rect {
                x: -1800,
                y: 0,
                width: 400,
                height: 820,
            },
            work,
            Size {
                width: 1180,
                height: 820,
            },
            Size {
                width: 900,
                height: 640,
            },
            12,
            None,
            0,
        );
        assert!(placement.rect.x >= work.x);
        assert!(placement.rect.right() <= work.right());
        assert!(placement.rect.y >= work.y);
        assert!(placement.rect.bottom() <= work.bottom());
    }
}
