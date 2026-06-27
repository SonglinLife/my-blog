use std::alloc::{GlobalAlloc, Layout, System};
use std::ptr;
use std::sync::atomic::{AtomicUsize, Ordering};

struct MovingAllocator;

static REALLOC_CALLS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for MovingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        REALLOC_CALLS.fetch_add(1, Ordering::SeqCst);

        if new_size == 0 {
            System.dealloc(ptr, layout);
            return ptr::null_mut();
        }

        let new_layout = Layout::from_size_align_unchecked(new_size, layout.align());
        let new_ptr = System.alloc(new_layout);

        if !new_ptr.is_null() {
            ptr::copy_nonoverlapping(ptr, new_ptr, layout.size().min(new_size));
            System.dealloc(ptr, layout);
        }

        new_ptr
    }
}

#[global_allocator]
static ALLOCATOR: MovingAllocator = MovingAllocator;

fn main() {
    let mut v = Vec::with_capacity(1);
    v.push(10);

    let old_raw_ptr = v.as_ptr();

    println!(
        "before push: ptr = {old_raw_ptr:p}, len = {}, cap = {}",
        v.len(),
        v.capacity()
    );

    let reallocs_before = REALLOC_CALLS.load(Ordering::SeqCst);
    v.push(20);
    let reallocs_after = REALLOC_CALLS.load(Ordering::SeqCst);

    println!(
        "after  push: ptr = {:p}, len = {}, cap = {}",
        v.as_ptr(),
        v.len(),
        v.capacity()
    );
    println!(
        "realloc calls during push: {}",
        reallocs_after - reallocs_before
    );
    println!("raw pointer still stores old address: {old_raw_ptr:p}");
    println!("old and new addresses differ: {}", old_raw_ptr != v.as_ptr());
}
